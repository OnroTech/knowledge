import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { flatten } from "../server/indexing";
import { createStore, type Resource, type Actor } from "../server/db";
import {
  runKnowledgeSync,
  sourceKey,
  type SyncConfig,
} from "../server/knowledge-sync";
import { createWorkers } from "../server/workers";
import { queues, LostJobClaim, type BackgroundJob } from "../server/jobs";
import { enqueueMissingThumbnails } from "../server/thumbnails";
import { enqueueIndex } from "../server/indexing-jobs";
import { testDatabase } from "./database";
import { retrieveDocuments } from "../server/retrieval";
import {
  createCitationLocator,
  citationPromptSource,
} from "../server/citation-sources";
import { isScoreRequest, scoreResponse, choiceResponse } from "./model-tools";

test("PostgreSQL sync lifecycle, isolation, fencing, search and citations", async (t) => {
  const database = await testDatabase();
  const directory = mkdtempSync(join(tmpdir(), "onro-sync-"));
  const store = await createStore(directory, database.url);
  const workers = createWorkers(store, { origin: "http://localhost:4310" });
  const source = {
    owner: "OnroTech",
    repo: "knowledge",
    ref: "main",
    prefixes: ["docs/"],
  };
  const user = randomUUID(),
    org = randomUUID(),
    other = randomUUID();
  const config: SyncConfig = {
    githubToken: "test-only",
    organizationId: org,
    ownerUserId: user,
    sources: [source],
  };
  let text =
    "onro_knowledge: approved-nonpii\n# Rental process\nQuasar operations follow the approved process.";
  let files = true,
    truncated = false,
    blobFails = false,
    scanFails = false;
  let commit = "a".repeat(40);
  let hold: (() => Promise<void>) | undefined;
  const revision = () =>
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex");
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes("/commits/")) {
      await hold?.();
      if (scanFails) return new Response("", { status: 503 });
      return Response.json({
        sha: commit,
        commit: { tree: { sha: "b".repeat(40) } },
      });
    }
    if (String(url).includes("/git/trees/"))
      return Response.json({
        truncated,
        tree: files
          ? [
              {
                path: "docs/process.md",
                sha: revision(),
                size: Buffer.byteLength(text),
                type: "blob",
                mode: "100644",
              },
            ]
          : [],
      });
    if (blobFails) return new Response("", { status: 503 });
    return Response.json({
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    });
  };
  const sync = (cfg = config) =>
    runKnowledgeSync(store, undefined, { config: cfg, fetcher });
  const manifest = () =>
    store.one<any>(
      "SELECT * FROM knowledge_source_manifest WHERE org_id=?",
      org,
    );
  const resource = async () =>
    store.one<Resource>(
      "SELECT * FROM resources WHERE id=?",
      (await manifest()).resource_id,
    );
  const index = async () => {
    await workers.start([queues.index]);
    try {
      const deadline = Date.now() + 15000;
      while ((await resource())?.status !== "ready") {
        if (Date.now() > deadline)
          throw new Error("Index worker did not finish");
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await workers.stop([queues.index]);
    }
  };
  try {
    await store.transaction(async () => {
      await store.run(
        "INSERT INTO users(id,email,name,email_verified) VALUES(?,'sync@local.test','Sync test',true)",
        user,
      );
      for (const id of [org, other]) {
        await store.run(
          "INSERT INTO orgs(id,name,settings) VALUES(?,'Isolated sync test',?)",
          id,
          store.encrypt(JSON.stringify({ organization: { enabled: false } })),
        );
        await store.run(
          "INSERT INTO members(org_id,user_id,role) VALUES(?,?,'admin')",
          id,
          user,
        );
      }
    });
    await t.test("migration is applied once", async () =>
      assert.equal(
        (
          await store.one<any>(
            "SELECT count(*) AS count FROM schema_migrations WHERE version=25",
          )
        )?.count,
        1,
      ),
    );
    let stableId: string;
    await t.test(
      "initial ingestion and duplicate events retain one ID and one index job",
      async () => {
        await sync();
        stableId = (await manifest()).resource_id;
        const job = (await resource())!.index_job_id;
        await Promise.all([sync(), sync()]);
        assert.equal((await manifest()).resource_id, stableId);
        assert.equal((await resource())!.index_job_id, job);
        assert.equal(
          (
            await store.one<any>(
              "SELECT count(*) AS count FROM knowledge_source_manifest WHERE org_id=?",
              org,
            )
          ).count,
          1,
        );
        await index();
      },
    );
    const actor: Actor = { orgId: org, userId: user, role: "admin", token: "" };
    const modelFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return isScoreRequest(body)
        ? scoreResponse(body, 3)
        : choiceResponse(body);
    };
    await t.test(
      "worker-produced index is searchable and has citation targets",
      async () => {
        const result = await retrieveDocuments(
          store,
          actor,
          "Quasar operations",
          "test",
          modelFetch,
        );
        assert.ok(result.results.length);
        assert.ok(result.results[0].nodeId);
        assert.ok(result.results[0].passageId);
        const nodes = flatten(JSON.parse((await resource())!.parsed!).nodes);
        assert.ok(
          result.results.some((source) =>
            nodes.some((node) => node.id === source.nodeId),
          ),
        );
        assert.ok(
          result.results.some((source) => source.content.includes("Quasar")),
        );
        assert.equal(result.results[0].documentId, stableId!);
        const layout = await createCitationLocator(store)(result.results);
        assert.equal(
          citationPromptSource(result.results[0], 1, layout.get(stableId!))
            .reference,
          "[1]",
        );

        assert.match((await resource())!.description, new RegExp(commit));
      },
    );
    await t.test(
      "test and production organization IDs are isolated",
      async () => {
        await sync({ ...config, organizationId: other });
        const row = await store.one<any>(
          "SELECT * FROM knowledge_source_manifest WHERE org_id=?",
          other,
        );
        assert.notEqual(row.resource_id, stableId!);
      },
    );
    await t.test(
      "failed replacement hides old index and successful retry reuses ID",
      async () => {
        text = text.replace("Quasar", "Nebula");
        commit = "c".repeat(40);
        blobFails = true;
        await assert.rejects(sync());
        assert.equal((await manifest()).state, "pending");
        assert.equal((await resource())!.parsed, null);
        await enqueueMissingThumbnails(store);
        assert.equal((await resource())!.thumbnail_job_id, null);
        assert.equal(
          (await retrieveDocuments(store, actor, "Quasar", "test", modelFetch))
            .results.length,
          0,
        );
        await assert.rejects(
          enqueueIndex(store, stableId!),
          /awaiting synchronization/,
        );
        blobFails = false;
        await sync();
        await index();
        assert.equal((await manifest()).resource_id, stableId!);
        assert.match((await resource())!.description, new RegExp(commit));
        assert.equal(
          await store.one(
            "SELECT 1 FROM knowledge_sync_findings WHERE org_id=? AND kind='sync_failed'",
            org,
          ),
          undefined,
        );
      },
    );
    await t.test(
      "incomplete scan and failed scan cannot infer deletion",
      async () => {
        files = false;
        truncated = true;
        await assert.rejects(sync());
        assert.equal((await manifest()).state, "active");
        truncated = false;
        scanFails = true;
        await assert.rejects(sync());
        assert.equal((await manifest()).state, "active");
        scanFails = false;
        assert.ok(
          await store.one(
            "SELECT 1 FROM knowledge_sync_findings WHERE org_id=? AND kind='scan_failed'",
            org,
          ),
        );
      },
    );
    await t.test(
      "complete deletion retires and cannot be manually reindexed",
      async () => {
        await sync();
        assert.equal((await manifest()).state, "retired");
        await assert.rejects(enqueueIndex(store, stableId!), /retired/);
        assert.equal((await resource())!.parsed, null);
        assert.equal(
          (
            await store.one<any>(
              "SELECT state FROM knowledge_source_manifest WHERE org_id=?",
              other,
            )
          ).state,
          "active",
        );
        files = true;
        await sync();
        await index();
        assert.equal((await manifest()).resource_id, stableId!);
      },
    );
    await t.test("index failure findings resolve after recovery", async () => {
      await store.run(
        "UPDATE resources SET status='failed' WHERE id=?",
        stableId!,
      );
      await sync();
      assert.ok(
        await store.one(
          "SELECT 1 FROM knowledge_sync_findings WHERE org_id=? AND kind='index_failed'",
          org,
        ),
      );
      await enqueueIndex(store, stableId!);
      await store.run(
        "UPDATE resources SET status='queued' WHERE id=?",
        stableId!,
      );
      await index();
      await sync();
      assert.equal(
        await store.one(
          "SELECT 1 FROM knowledge_sync_findings WHERE org_id=? AND kind='index_failed'",
          org,
        ),
        undefined,
      );
    });
    await t.test("stale sources are withheld after scan failure", async () => {
      await store.run(
        "UPDATE knowledge_source_manifest SET last_seen_at=now()-interval '2 days' WHERE org_id=?",
        org,
      );
      scanFails = true;
      await assert.rejects(sync());
      assert.equal((await manifest()).state, "pending");
      assert.ok(
        await store.one(
          "SELECT 1 FROM knowledge_sync_findings WHERE org_id=? AND kind='stale'",
          org,
        ),
      );
      scanFails = false;
      await sync();
      await index();
    });
    await t.test(
      "lost job claim cannot mutate and overlapping scans do not race",
      async () => {
        const before = (await manifest()).revision;
        await assert.rejects(
          runKnowledgeSync(store, undefined, {
            config,
            fetcher,
            guard: async () => {
              throw new LostJobClaim();
            },
          }),
        );
        assert.equal((await manifest()).revision, before);
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>((r) => (enter = r)),
          blocked = new Promise<void>((r) => (release = r));
        hold = async () => {
          enter();
          await blocked;
        };
        const first = sync();
        await entered;
        await sync();
        release();
        await first;
        hold = undefined;
        assert.equal((await manifest()).revision, before);
      },
    );
    await t.test(
      "existing worker consumes a knowledge-sync job with claim fencing",
      async () => {
        const environment = {
          ONRO_KNOWLEDGE_SYNC_ENABLED: "true",
          ONRO_KNOWLEDGE_ORG_ID: org,
          ONRO_KNOWLEDGE_OWNER_USER_ID: user,
          ONRO_KNOWLEDGE_GITHUB_TOKEN: "test-only",
          ONRO_KNOWLEDGE_SOURCES: JSON.stringify([source]),
        };
        const previous = Object.fromEntries(
          Object.keys(environment).map((key) => [key, process.env[key]]),
        );
        const syncWorkers = createWorkers(store, {
          origin: "http://localhost:4310",
          fetcher,
        });
        try {
          Object.assign(process.env, environment);
          const id = await store.jobs.send(queues.knowledgeSync, {});
          const [fetched] = await store.jobs.boss.fetch(queues.knowledgeSync, {
            includeMetadata: true,
          });
          assert.equal(fetched.id, id);
          const result = await syncWorkers.handle({
            ...fetched,
            signal: new AbortController().signal,
          } as BackgroundJob);
          assert.equal(result[0].status, "completed");
          const job = await store.db.query(
            `SELECT state FROM "${store.jobs.schema}".job WHERE id=$1`,
            [id],
          );
          assert.equal(job.rows[0].state, "completed");
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      },
    );
    await t.test(
      "removed source configuration retires only its organization's corpus",
      async () => {
        await sync({ ...config, sources: [{ ...source, repo: "other" }] });
        const old = await store.one<any>(
          "SELECT state FROM knowledge_source_manifest WHERE org_id=? AND source_key=?",
          org,
          sourceKey(source, "docs/process.md"),
        );
        assert.equal(old.state, "retired");
      },
    );
    await t.test(
      "rejected files cannot starve later approved documents",
      async () => {
        const rejected = Buffer.from("Not approved for ingestion");
        const badSha = createHash("sha1")
          .update(`blob ${rejected.length}\0`)
          .update(rejected)
          .digest("hex");
        const batchSource = { ...source, repo: "batch" };
        const batchFetch: typeof fetch = async (url) => {
          if (String(url).includes("/git/trees/"))
            return Response.json({
              truncated: false,
              tree: [
                ...Array.from({ length: 20 }, (_, i) => ({
                  path: `docs/${i}.md`,
                  sha: badSha,
                  size: rejected.length,
                  type: "blob",
                  mode: "100644",
                })),
                {
                  path: "docs/zz.md",
                  sha: revision(),
                  size: Buffer.byteLength(text),
                  type: "blob",
                  mode: "100644",
                },
              ],
            });
          if (String(url).endsWith(badSha))
            return Response.json({
              encoding: "base64",
              content: rejected.toString("base64"),
            });
          return fetcher(url);
        };
        const run = () =>
          runKnowledgeSync(store, undefined, {
            config: { ...config, sources: [batchSource] },
            fetcher: batchFetch,
          });
        await assert.rejects(run());
        await assert.rejects(run());
        const row = await store.one<any>(
          "SELECT * FROM knowledge_source_manifest WHERE org_id=? AND source_key=?",
          org,
          sourceKey(batchSource, "docs/zz.md"),
        );
        assert.equal(row.state, "active");
      },
    );
  } finally {
    await workers.close();
    await database.cleanup(store);
    rmSync(directory, { recursive: true, force: true });
  }
});
