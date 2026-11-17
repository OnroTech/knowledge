import { resolve } from "node:path";
import { createStore } from "../server/db";
import { runKnowledgeSync, validateSources } from "../server/knowledge-sync";

const organizationId = process.env.ONRO_KNOWLEDGE_ORG_ID;
if (
  !organizationId ||
  process.env.ONRO_KNOWLEDGE_TEST_ORG_ID !== organizationId
)
  throw new Error("Explicit matching test organization ID is required");
if (process.env.ONRO_KNOWLEDGE_SYNC_ENABLED === "true")
  throw new Error("Disable scheduled synchronization during acceptance");
const githubToken = process.env.ONRO_KNOWLEDGE_GITHUB_TOKEN;
const ownerUserId = process.env.ONRO_KNOWLEDGE_OWNER_USER_ID;
if (!githubToken || !ownerUserId)
  throw new Error("Missing test sync configuration");
const sources = validateSources(process.env.ONRO_KNOWLEDGE_SOURCES ?? "[]");
const store = await createStore(resolve(process.env.DATA_DIR ?? ".data"));
try {
  await runKnowledgeSync(store, AbortSignal.timeout(360_000), {
    config: { organizationId, ownerUserId, githubToken, sources },
  });
  console.info(
    "Test ingestion complete; verify index jobs, search and citations before activation",
  );
} finally {
  await store.close();
}
