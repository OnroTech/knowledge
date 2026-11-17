import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import express, { type ErrorRequestHandler } from "express";
import { createFileDownloads, downloadLimits } from "../server/file-downloads";
import { HttpError, type Resource, type Store } from "../server/db";

function source(bytes = 1024 * 1024) {
  let reads = 0;
  const body = Buffer.alloc(bytes, 65);
  const store = {
    one: async () => undefined,
    files: {
      download: async () => ({
        size: bytes,
        sha256: createHash("sha256").update(body).digest("hex"),
        async *chunks() {
          reads++;
          for (let offset = 0; offset < bytes; offset += 65536)
            yield body.subarray(offset, offset + 65536);
        },
      }),
      read: () =>
        assert.fail("Original downloads must not use whole-file reads"),
    },
  } as unknown as Store;
  return { store, reads: () => reads };
}

test("download staging bounds disk use, verifies content, and releases capacity after cleanup", async () => {
  const { store } = source();
  const downloads = createFileDownloads(store, {
    ...downloadLimits,
    tempBytes: 1048576,
  });
  const signal = new AbortController().signal;
  const staged = await downloads.stage("document", signal);
  assert.equal((await stat(staged.path)).size, 1048576);
  await assert.rejects(
    downloads.stage("document", signal),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
  await staged.dispose();
  await assert.rejects(stat(staged.path));
  const again = await downloads.stage("document", signal);
  await again.dispose();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloads.stage("document", controller.signal));
  const afterAbort = await downloads.stage("document", signal);
  await afterAbort.dispose();
});

test("failed integrity checks clean up temporary capacity", async () => {
  const { store } = source();
  const original = store.files.download;
  store.files.download = async (id) => ({
    ...(await original(id)),
    sha256: "incorrect",
  });
  const downloads = createFileDownloads(store, {
    ...downloadLimits,
    tempBytes: 1048576,
  });
  await assert.rejects(
    downloads.stage("document", new AbortController().signal),
    /integrity/,
  );
  store.files.download = original;
  const staged = await downloads.stage(
    "document",
    new AbortController().signal,
  );
  await staged.dispose();
});

test("ranges stream selected bytes, HEAD skips bodies, and revoked access returns no content", async () => {
  const fixture = source();
  const downloads = createFileDownloads(fixture.store);
  const app = express();
  let revoked = false;
  app.get("/content", async (req, res) =>
    downloads.send(
      req,
      res,
      { id: "document", name: "content.txt", mime: "text/plain" } as Resource,
      async () => {
        if (revoked) throw new HttpError(403, "Forbidden");
      },
      "user",
    ),
  );
  app.use(((error, _req, res, _next) =>
    res
      .status(error.status ?? 500)
      .json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/content`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "1048576");
    assert.equal(fixture.reads(), 0);
    const range = await fetch(url, { headers: { Range: "bytes=10-19" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 10-19/1048576");
    assert.equal(await range.text(), "AAAAAAAAAA");
    assert.equal(fixture.reads(), 1);
    const invalid = await fetch(url, { headers: { Range: "bytes=1048576-" } });
    assert.equal(invalid.status, 416);
    assert.equal(fixture.reads(), 1);
    revoked = true;
    const blocked = await fetch(url);
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: "Forbidden" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retired or pending managed documents cannot serve obsolete bytes", async () => {
  const fixture = source();
  fixture.store.one = async () => ({ withheld: true }) as never;
  await assert.rejects(
    createFileDownloads(fixture.store).stage(
      "document",
      new AbortController().signal,
    ),
    /retired or awaiting synchronization/,
  );
  assert.equal(fixture.reads(), 0);
});

test("a revision changed during staging is rejected before streaming", async () => {
  const fixture = source(32);
  let revision = "old";
  fixture.store.one = async () => ({ state: "active", revision }) as never;
  const downloads = createFileDownloads(fixture.store);
  const app = express();
  app.get("/content", async (req, res) =>
    downloads.send(
      req,
      res,
      { id: "document", name: "content.txt", mime: "text/plain" } as Resource,
      async () => {
        revision = "new";
      },
      "user",
    ),
  );
  app.use(((error, _req, res, _next) =>
    res
      .status(error.status ?? 500)
      .json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/content`);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /revision changed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
