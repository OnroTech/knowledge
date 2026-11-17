import { createHash } from "node:crypto";
import type { Store, Actor, Resource } from "./db";
import { createUploads } from "./uploads";
import { enqueueIndex } from "./indexing-jobs";
import { enqueueThumbnail } from "./thumbnails";
import { checkStoredDocumentQuota } from "./upload-quotas";
import { queues } from "./jobs";

export type GitHubSource = {
  owner: string;
  repo: string;
  ref: string;
  prefixes: string[];
};
export type SyncConfig = {
  githubToken: string;
  organizationId: string;
  ownerUserId: string;
  sources: GitHubSource[];
};
type Manifest = {
  source_key: string;
  resource_id: string;
  revision: string;
  state: string;
};
type BlobRef = {
  path: string;
  sha: string;
  size: number;
  type: string;
  mode: string;
};
type Options = {
  config?: SyncConfig;
  fetcher?: typeof fetch;
  guard?: <T>(fn: () => Promise<T>) => Promise<T>;
};
const identifier = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const fileLimit = 256 * 1024;

export function isAllowedPath(path: string, prefixes: string[]) {
  if (
    typeof path !== "string" ||
    /[\\\x00-\x1f\x7f]/.test(path) ||
    path.startsWith("/")
  )
    return false;
  if (
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p.startsWith(".") ||
          /^(secrets?|credentials?|private|customers?|pii|node_modules)$/i.test(
            p,
          ),
      )
  )
    return false;
  return (
    /\.(md|mdx|txt)$/i.test(path) && prefixes.some((p) => path.startsWith(p))
  );
}
export function sourceKey(source: GitHubSource, path: string) {
  return `github:${source.owner.toLowerCase()}/${source.repo.toLowerCase()}@${source.ref}:${path}`;
}
export function validateSources(json: string): GitHubSource[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw) || !raw.length || raw.length > 4)
    throw new Error("Expected 1-4 sources");
  const seen = new Set<string>();
  return raw.map((s) => {
    if (
      !s ||
      ![s.owner, s.repo, s.ref].every(
        (v) => typeof v === "string" && identifier.test(v),
      )
    )
      throw new Error("Invalid source identifier");
    if (
      !Array.isArray(s.prefixes) ||
      !s.prefixes.length ||
      s.prefixes.length > 10 ||
      s.prefixes.some(
        (p: unknown) =>
          typeof p !== "string" ||
          !/^docs\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*$/.test(p),
      )
    )
      throw new Error("Only explicit docs/ directory prefixes are allowed");
    const source: GitHubSource = {
      owner: s.owner,
      repo: s.repo,
      ref: s.ref,
      prefixes: s.prefixes,
    };
    const key = sourceKey(source, "");
    if (seen.has(key))
      throw new Error("Duplicate source; combine its prefixes");
    seen.add(key);
    return source;
  });
}
function loadEnv(): SyncConfig {
  const config = {
    githubToken: process.env.ONRO_KNOWLEDGE_GITHUB_TOKEN ?? "",
    organizationId: process.env.ONRO_KNOWLEDGE_ORG_ID ?? "",
    ownerUserId: process.env.ONRO_KNOWLEDGE_OWNER_USER_ID ?? "",
    sources: validateSources(process.env.ONRO_KNOWLEDGE_SOURCES ?? "[]"),
  };
  if (!config.githubToken || !config.organizationId || !config.ownerUserId)
    throw new Error("Missing sync configuration");
  return config;
}
// Classification is explicit and human supplied. Detectors are defense in depth,
// not a substitute for approving a non-PII corpus before configuring its prefixes.
export function validateContent(bytes: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^onro_knowledge: approved-nonpii\s*$/m.test(text))
    throw new Error("Document lacks non-PII ingestion approval");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,})\b|(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\/+.-]{12,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d[ -]?){10,16}\b/i.test(
      text,
    )
  )
    throw new Error("Document requires sensitive-content review");
  return text;
}
export async function scanSource(
  source: GitHubSource,
  token: string,
  fetcher = fetch,
  signal?: AbortSignal,
) {
  const json = async <T>(path: string, limit = 8 * 1024 * 1024): Promise<T> => {
    signal?.throwIfAborted();
    const response = await fetcher(
      `https://api.github.com/repos/${source.owner}/${source.repo}/${path}`,
      {
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    if (!response.body) throw new Error("Missing GitHub body");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error("GitHub response exceeds limit");
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  };
  const commit = await json<{ sha: string; commit: { tree: { sha: string } } }>(
    `commits/${encodeURIComponent(source.ref)}`,
  );
  if (
    !shaPattern.test(commit.sha) ||
    !shaPattern.test(commit.commit?.tree?.sha)
  )
    throw new Error("Invalid commit");
  const tree = await json<{ truncated: boolean; tree: BlobRef[] }>(
    `git/trees/${commit.commit.tree.sha}?recursive=1`,
  );
  if (tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error("Incomplete GitHub scan");
  const paths = new Set<string>();
  for (const item of tree.tree) {
    if (
      !item ||
      typeof item.path !== "string" ||
      !shaPattern.test(item.sha) ||
      !["blob", "tree", "commit"].includes(item.type) ||
      paths.has(item.path)
    )
      throw new Error("Malformed GitHub tree");
    paths.add(item.path);
  }
  const files = tree.tree.filter(
    (x) =>
      x.type === "blob" &&
      ["100644", "100755"].includes(x.mode) &&
      isAllowedPath(x.path, source.prefixes),
  );
  if (
    files.length > 150 ||
    files.some(
      (x) => !Number.isSafeInteger(x.size) || x.size < 0 || x.size > fileLimit,
    )
  )
    throw new Error("Source exceeds document limits");
  return {
    files,
    commitSha: commit.sha,
    async read(file: BlobRef) {
      const data = await json<{ encoding: string; content: string }>(
        `git/blobs/${file.sha}`,
        fileLimit * 2,
      );
      if (data.encoding !== "base64" || typeof data.content !== "string")
        throw new Error("Invalid blob encoding");
      const encoded = data.content.replace(/\s/g, "");
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") !== encoded ||
        bytes.length !== file.size ||
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== file.sha
      )
        throw new Error("Invalid blob integrity");
      return validateContent(bytes);
    },
  };
}

async function synchronize(
  store: Store,
  signal: AbortSignal | undefined,
  options: Options & { config: SyncConfig },
) {
  // Explicit config is only used by the isolated acceptance runner/tests. Scheduled
  // work always uses the deployment kill switch, including already queued jobs.
  if (!options.config && process.env.ONRO_KNOWLEDGE_SYNC_ENABLED !== "true")
    return;
  const config = options.config ?? loadEnv();
  validateSources(JSON.stringify(config.sources));
  const org = config.organizationId;
  const guard =
    options.guard ?? (<T>(fn: () => Promise<T>) => store.transaction(fn));
  const mutate = <T>(fn: () => Promise<T>) =>
    guard(async () => {
      signal?.throwIfAborted();
      const result = await fn();
      signal?.throwIfAborted();
      return result;
    });
  const actor = async (): Promise<Actor> => {
    const member = await store.one<{ role: string }>(
      "SELECT role FROM members WHERE org_id=? AND user_id=?",
      org,
      config.ownerUserId,
    );
    if (member?.role !== "admin")
      throw new Error("Knowledge owner must remain an organization admin");
    return { orgId: org, userId: config.ownerUserId, role: "admin", token: "" };
  };
  await actor();
  const finding = (key: string, kind: string, detail: string) =>
    store.run(
      "INSERT INTO knowledge_sync_findings(org_id,source_key,kind,detail) VALUES(?,?,?,?) ON CONFLICT(org_id,source_key,kind) DO UPDATE SET detail=EXCLUDED.detail,updated_at=now()",
      org,
      key,
      kind,
      detail,
    );
  const clear = (key: string, kind: string) =>
    store.run(
      "DELETE FROM knowledge_sync_findings WHERE org_id=? AND source_key=? AND kind=?",
      org,
      key,
      kind,
    );
  const invalidate = async (row: Manifest, state: "pending" | "retired") => {
    const resource = await store.one<Resource>(
      "SELECT * FROM resources WHERE id=? AND org_id=? FOR UPDATE",
      row.resource_id,
      org,
    );
    if (!resource) throw new Error("Missing managed document");
    if (resource.index_job_id)
      await store.jobs.cancel(queues.index, resource.index_job_id);
    if (resource.thumbnail_job_id)
      await store.jobs.cancel(queues.thumbnail, resource.thumbnail_job_id);
    const filing = await store.one<{ job_id: string }>(
      "SELECT job_id FROM document_filing WHERE resource_id=?",
      resource.id,
    );
    if (filing?.job_id) await store.jobs.cancel(queues.filing, filing.job_id);
    await store.run(
      "UPDATE document_filing SET state='disabled',job_id=NULL,attempt_id=NULL WHERE resource_id=?",
      resource.id,
    );
    await store.run(
      "UPDATE resources SET status=?,parsed=NULL,parse_run=NULL,parse_requested=false,index_job_id=NULL,thumbnail_job_id=NULL,thumbnail_status='failed',thumbnail_key=NULL,error=? WHERE id=?",
      state === "retired" ? "retired" : "source_pending",
      state === "retired"
        ? "Source retired"
        : "Source changed; synchronization pending",
      resource.id,
    );
    await store.run(
      "UPDATE knowledge_source_manifest SET state=?,updated_at=now() WHERE org_id=? AND source_key=?",
      state,
      org,
      row.source_key,
    );
  };
  await mutate(async () => {
    const rows = await store.all<Manifest>(
      "SELECT * FROM knowledge_source_manifest WHERE org_id=? AND state<>'retired'",
      org,
    );
    for (const row of rows)
      if (
        !config.sources.some((source) =>
          row.source_key.startsWith(sourceKey(source, "")),
        )
      ) {
        await invalidate(row, "retired");
        await finding(
          row.source_key,
          "source_retired",
          "Source removed from configured approved corpus",
        );
      }
  });
  let failures = 0;
  for (const source of config.sources) {
    const prefix = sourceKey(source, "");
    // Dedicated connection holds a session lock across the network scan. Never
    // hold Jevbox's global write transaction open during GitHub requests.
    const lock = await store.db.connect();
    let locked = false;
    try {
      const result = await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [`${org}:${prefix}`],
      );
      locked = result.rows[0].acquired;
      if (!locked) continue;
      const scan = await scanSource(
        source,
        config.githubToken,
        options.fetcher,
        signal,
      );
      const previous = await store.all<Manifest>(
        "SELECT * FROM knowledge_source_manifest WHERE org_id=? AND starts_with(source_key,?)",
        org,
        prefix,
      );
      const visible = new Set(scan.files.map((f) => sourceKey(source, f.path)));
      // Full tree is validated before deletions. Blob failures cannot turn a file
      // into a deletion; changed files are unavailable before the first fetch.
      await mutate(async () => {
        await actor();
        for (const row of previous) {
          const file = scan.files.find(
            (f) => sourceKey(source, f.path) === row.source_key,
          );
          if (!visible.has(row.source_key) && row.state !== "retired") {
            await invalidate(row, "retired");
            await finding(
              row.source_key,
              "source_retired",
              "Removed from approved source snapshot",
            );
          } else if (
            file &&
            row.state !== "pending" &&
            (file.sha !== row.revision || row.state === "retired")
          ) {
            await invalidate(row, "pending");
            await finding(
              row.source_key,
              "source_updated",
              "Source changed; human review of affected decisions may be needed",
            );
          }
          if (file)
            await store.run(
              "UPDATE knowledge_source_manifest SET last_seen_at=now() WHERE org_id=? AND source_key=?",
              org,
              row.source_key,
            );
        }
      });
      // Retry oldest failures last relative to never-attempted documents. This
      // bounded rotation prevents permanently rejected files starving the corpus.
      const attempts = await store.all<{
        source_key: string;
        attempted: number;
      }>(
        "SELECT source_key,extract(epoch from updated_at)::float8 AS attempted FROM knowledge_sync_findings WHERE org_id=? AND kind='sync_failed' AND starts_with(source_key,?)",
        org,
        prefix,
      );
      const attempted = new Map(
        attempts.map((row) => [row.source_key, row.attempted]),
      );
      const ordered = [...scan.files].sort(
        (a, b) =>
          (attempted.get(sourceKey(source, a.path)) ?? 0) -
          (attempted.get(sourceKey(source, b.path)) ?? 0),
      );
      let changes = 0;
      for (const file of ordered) {
        signal?.throwIfAborted();
        const key = sourceKey(source, file.path);
        const old = await store.one<Manifest>(
          "SELECT * FROM knowledge_source_manifest WHERE org_id=? AND source_key=?",
          org,
          key,
        );
        if (old?.state === "active" && old.revision === file.sha) continue;
        if (++changes > 20) continue;
        try {
          const body = await scan.read(file);
          const url = `https://github.com/${source.owner}/${source.repo}/blob/${scan.commitSha}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
          const stored = Buffer.from(
            `Source: ${url}\nRevision: ${file.sha}\n\n${body}`,
          );
          const name = `${source.repo.slice(0, 40)}__${createHash("sha256").update(key).digest("hex").slice(0, 16)}.md`;
          await mutate(async () => {
            const currentActor = await actor();
            let id: string;
            if (old) {
              id = old.resource_id;
              const resource = await store.one<Resource>(
                "SELECT * FROM resources WHERE id=? AND org_id=? FOR UPDATE",
                id,
                org,
              );
              if (!resource) throw new Error("Missing managed document");
              await checkStoredDocumentQuota(
                store,
                resource.owner_id,
                org,
                Math.max(0, stored.length - resource.size),
              );
              await store.files.write("document", id, stored, "text/markdown");
              await store.run(
                "UPDATE resources SET status='queued',thumbnail_status='pending',error=NULL,name=?,description=?,mime='text/markdown',size=? WHERE id=?",
                name,
                url,
                stored.length,
                id,
              );
              await store.run(
                "UPDATE knowledge_source_manifest SET revision=?,state='active',last_seen_at=now(),updated_at=now() WHERE org_id=? AND source_key=?",
                file.sha,
                org,
                key,
              );
              await enqueueIndex(store, id);
              await enqueueThumbnail(store, id);
            } else {
              const saved = await createUploads(store, {
                rateLimits: false,
              }).save(currentActor, name, stored, null, actor, signal);
              id = saved.id;
              await store.run(
                "UPDATE resources SET access='organization',description=? WHERE id=?",
                url,
                id,
              );
              await store.run(
                "UPDATE document_filing SET state='disabled' WHERE resource_id=?",
                id,
              );
              await store.run(
                "INSERT INTO knowledge_source_manifest(org_id,source_key,resource_id,revision,state) VALUES(?,?,?,?,'active')",
                org,
                key,
                id,
                file.sha,
              );
            }
            await clear(key, "sync_failed");
            await clear(key, "source_retired");
          });
        } catch {
          signal?.throwIfAborted();
          failures++;
          await mutate(async () => {
            await finding(
              key,
              "sync_failed",
              "Approved document could not be synchronized; inspect source classification, limits and job configuration",
            );
          });
        }
      }
      await mutate(async () => {
        await clear(prefix, "scan_failed");
      });
    } catch {
      signal?.throwIfAborted();
      failures++;
      await mutate(async () => {
        await finding(
          prefix,
          "scan_failed",
          "Source scan failed or incomplete; no deletions inferred from that scan",
        );
      });
    } finally {
      try {
        if (locked)
          await lock.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [`${org}:${prefix}`],
          );
        lock.release();
      } catch {
        lock.release(true);
      }
    }
  }
  await mutate(async () => {
    const rows = await store.all<Manifest & { status: string; stale: boolean }>(
      "SELECT m.*,r.status,m.last_seen_at<now()-interval '24 hours' AS stale FROM knowledge_source_manifest m JOIN resources r ON r.id=m.resource_id WHERE m.org_id=? AND m.state<>'retired'",
      org,
    );
    for (const row of rows) {
      if (row.status === "failed" && row.state === "active")
        await finding(
          row.source_key,
          "index_failed",
          "Indexing failed; retry through Jevbox after fixing provider configuration",
        );
      else await clear(row.source_key, "index_failed");
      if (row.stale) {
        await finding(
          row.source_key,
          "stale",
          "Source has not been verified in 24 hours; withheld until synchronization succeeds",
        );
        await invalidate(row, "pending");
      } else await clear(row.source_key, "stale");
    }
  });
  if (failures)
    throw new Error(
      "Knowledge sync failed; consult organization-scoped findings",
    );
}

export async function runKnowledgeSync(
  store: Store,
  signal?: AbortSignal,
  options: Options = {},
) {
  if (!options.config && process.env.ONRO_KNOWLEDGE_SYNC_ENABLED !== "true")
    return;
  const config = options.config ?? loadEnv();
  const client = await store.db.connect();
  let acquired = false;
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [`knowledge-sync:${config.organizationId}`],
    );
    acquired = result.rows[0].acquired;
    if (acquired) await synchronize(store, signal, { ...options, config });
  } finally {
    try {
      if (acquired)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [`knowledge-sync:${config.organizationId}`],
        );
      client.release();
    } catch {
      client.release(true);
    }
  }
}
