import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  isAllowedPath,
  sourceKey,
  validateSources,
  validateContent,
  scanSource,
  runKnowledgeSync,
} from "../server/knowledge-sync";
import type { Store } from "../server/db";
const source = {
  owner: "OnroTech",
  repo: "knowledge",
  ref: "main",
  prefixes: ["docs/"],
};
const body = Buffer.from(
  "onro_knowledge: approved-nonpii\n# Operations\nUse the approved process.",
);
const sha = createHash("sha1")
  .update(`blob ${body.length}\0`)
  .update(body)
  .digest("hex");
const blob = {
  path: "docs/operations.md",
  type: "blob",
  mode: "100644",
  size: body.length,
  sha,
};
const mock =
  (tree: unknown, content = body.toString("base64")): typeof fetch =>
  async (url) => {
    if (String(url).includes("/commits/"))
      return Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
      });
    if (String(url).includes("/git/trees/")) return Response.json(tree);
    return Response.json({ encoding: "base64", content });
  };
test("only explicitly approved documentation paths and unique source identities", () => {
  assert.equal(isAllowedPath("docs/guide.md", ["docs/"]), true);
  for (const path of [
    "src/main.ts",
    "docs/../.env",
    "docs/secrets/key.txt",
    "docs/private/a.md",
    "docs/customers/a.md",
    "docs/./a.md",
    "docs/a\\b.md",
  ])
    assert.equal(isAllowedPath(path, ["docs/"]), false);
  for (const prefixes of [[""], ["../"], ["docs"], ["docs/sub"], ["docs/../"]])
    assert.throws(() =>
      validateSources(JSON.stringify([{ ...source, prefixes }])),
    );
  assert.throws(() =>
    validateSources(JSON.stringify([source, { ...source, owner: "onrotech" }])),
  );
  assert.equal(
    sourceKey(source, "docs/a.md"),
    "github:onrotech/knowledge@main:docs/a.md",
  );
});
test("classification and defense-in-depth reject sensitive content before storage", () => {
  assert.equal(validateContent(body), body.toString());
  for (const content of [
    "# not reviewed",
    body + "\ncustomer@example.com",
    body + "\n-----BEGIN PRIVATE KEY-----",
    body + "\napi_key: abcdefghijklmnop",
  ])
    assert.throws(() => validateContent(Buffer.from(content)));
  assert.throws(() => validateContent(Buffer.from([0xff])));
});
test("complete immutable scan validates blob hash and content", async () => {
  const scan = await scanSource(
    source,
    "test",
    mock({ truncated: false, tree: [blob] }),
  );
  assert.equal(await scan.read(scan.files[0]), body.toString());
  const corrupt = await scanSource(
    source,
    "test",
    mock(
      { truncated: false, tree: [blob] },
      Buffer.from("bad").toString("base64"),
    ),
  );
  await assert.rejects(corrupt.read(corrupt.files[0]), /integrity/);
});
test("incomplete, malformed, oversized and duplicate GitHub scans fail closed", async () => {
  for (const tree of [
    { truncated: true, tree: [blob] },
    { tree: [] },
    { truncated: false, tree: [blob, blob] },
    { truncated: false, tree: [{ ...blob, size: 300000 }] },
    { truncated: false, tree: [{ ...blob, sha: "bad" }] },
  ])
    await assert.rejects(scanSource(source, "test", mock(tree)));
  await assert.rejects(
    scanSource(source, "test", async () => new Response("", { status: 503 })),
    /503/,
  );
});
test("aborted and disabled jobs do no network or database work", async () => {
  const previous = process.env.ONRO_KNOWLEDGE_SYNC_ENABLED;
  try {
    process.env.ONRO_KNOWLEDGE_SYNC_ENABLED = "false";
    await runKnowledgeSync({} as Store);
  } finally {
    if (previous === undefined) delete process.env.ONRO_KNOWLEDGE_SYNC_ENABLED;
    else process.env.ONRO_KNOWLEDGE_SYNC_ENABLED = previous;
  }
  await assert.rejects(
    scanSource(
      source,
      "test",
      async () => {
        throw new Error("must not fetch");
      },
      AbortSignal.abort(),
    ),
    /abort/i,
  );
});
