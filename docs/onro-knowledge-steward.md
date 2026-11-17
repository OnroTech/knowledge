# ONRO Knowledge Steward and Source Sync

This opt-in extension runs inside the existing Jevbox worker and PostgreSQL/pg-boss deployment. It introduces no new service, broker, model or knowledge platform. Migration 025 adds two isolated tables; it does not alter existing data. Automatic filing is disabled for managed documents. Findings never approve or rewrite business requirements.

## Approved corpus

An administrator configures 1–4 unique GitHub owner/repository/ref sources with explicit directory prefixes under `docs/`. All imported documents are readable by that Jevbox organization. Review the corpus and membership before configuration. Do not configure a mixed-permission corpus, customer records or secrets. Each eligible file must contain this human-supplied classification line:

```text
onro_knowledge: approved-nonpii
```

This authorizes ingestion, not approval of business requirements. Path and content checks reject common sensitive material before storage, but detectors cannot establish that arbitrary text contains no PII. The reviewed corpus and explicit classification are mandatory. Failed content is not logged or saved in findings. GitHub requests use HTTPS, fixed host, no redirects, bounded bodies, timeouts and immutable commit/blob SHA checks.

## Configuration

Keep the deployment flag false until a controlled test-organization run passes. Set secrets through the existing deployment secret store; never commit them.

```dotenv
ONRO_KNOWLEDGE_SYNC_ENABLED=false
ONRO_KNOWLEDGE_ORG_ID=<existing organization ID>
ONRO_KNOWLEDGE_OWNER_USER_ID=<its admin user ID>
ONRO_KNOWLEDGE_GITHUB_TOKEN=<read-only contents token limited to approved repositories>
ONRO_KNOWLEDGE_SOURCES=[{"owner":"OnroTech","repo":"knowledge","ref":"main","prefixes":["docs/approved/"]}]
```

Only the worker schedules the 15-minute queue when enabled. Disabled workers remove its persisted schedule and already queued scheduled jobs become no-ops. Do not run worker replicas with different flag/configuration values. The web only creates queue definitions. No Render Blueprint creation, Terraform apply or extra worker is needed.

## Lifecycle and concurrency

The manifest identity is `(org_id, normalized repository/ref/path)`. Blob revisions change while resource IDs stay stable. A rename intentionally retires the old path and creates a new document. Immutable GitHub commit permalinks are placed in the document text and description for provenance.

Dedicated PostgreSQL advisory locks serialize an organization's complete scan across replicas. Each mutation is fenced by the pg-boss claim and committed through Jevbox's transaction/storage layer. The scan never holds the global Jevbox write transaction during GitHub HTTP requests. Lost claims and aborted jobs cannot publish mutations.

A fully validated recursive tree is required before inferring deletions. Truncated/malformed trees, HTTP failures and size limits fail closed. Source files are capped at 150 per source and 256 KiB each. Each pass attempts at most 20 revisions per source; failed attempts rotate behind never-attempted or older failures to prevent starvation; all observed changed revisions are withheld immediately, including changes beyond the batch cap. Changed/retired resources lose parsed content and obsolete job IDs. New indexing jobs publish only active revisions. Manual retry and downloads cannot revive pending or retired content; the UI labels it unavailable. Existing chat answers remain historical records, not rewritten business decisions.

Deleting a file, excluding it by prefix or removing its source configuration retires its manifest/resource. Reappearance reuses the original resource ID. Removing every source requires an explicit replacement configuration or operator retirement; an empty configuration is rejected. Unreachable sources retain their previous state initially, with a scan finding; after 24 hours without successful verification their content is withheld. Staleness checks run on sync passes, so disabling sync also stops stewardship checks.

Findings are organization scoped: `source_updated`, `source_retired`, `sync_failed`, `scan_failed`, `index_failed`, and `stale`. Failure/recovery findings reconcile on later passes. Indexing failures can be retried through Jevbox after correcting provider configuration. Findings are available through database queries, not a new public API.

## Test and deployment procedure

1. Run `pnpm check`, `pnpm test`, and `pnpm build`. Integration tests require the repository's existing local PostgreSQL/SpiceDB setup (`pnpm setup:local`, `pnpm services:up`). The tests create isolated schemas/organizations and exercise real pg-boss indexing, search and citation construction with mocked GitHub/model responses.
2. Identify the existing target and record service IDs or cluster/namespace, deployed image/commit, and database backup. Migration 025 is additive and runs under the existing migration transaction/lock. Rollback code with synchronization disabled; retain the tables. Do not drop data during rollback.
3. Deploy the checked commit to existing web/worker only with `ONRO_KNOWLEDGE_SYNC_ENABLED=false`. Verify `/health/ready`, worker startup, ordinary upload/search and authentication before activation.
4. In an isolated test organization, use a synthetic non-PII GitHub fixture and its own admin. Execute `scripts/knowledge-sync-once.ts` from the existing worker runtime with `ONRO_KNOWLEDGE_TEST_ORG_ID` equal to the configured test organization, leaving the scheduled flag false. This is a controlled one-shot ingestion, not a second service. Keep the ordinary index worker running.
5. Verify indexing jobs complete; search for the fixture's unique phrase and open its citation. Change its text, repeat the one-shot, and verify the same resource ID with a new blob revision/permalink and no old search hit. Delete and repeat; verify retired state and retry/download rejection. Run an incomplete-tree/failure test in CI, never by corrupting production configuration.
6. Only after these checks pass, configure the approved real corpus and explicitly enable the flag on existing worker replicas. Observe a scheduled job and its manifest/findings. Keep web scheduling disabled. If any acceptance step fails, leave synchronization disabled.

```sql
SELECT org_id, source_key, resource_id, revision, state, last_seen_at
FROM knowledge_source_manifest WHERE org_id = '<organization ID>';
SELECT source_key, kind, detail, updated_at FROM knowledge_sync_findings
WHERE org_id = '<organization ID>' ORDER BY updated_at DESC;
-- Use the actual pg-boss schema for this deployment:
SELECT name, state, count(*) FROM pgboss.job
WHERE name IN ('knowledge-sync','document-index') GROUP BY name,state;
```

## Deployment discovery evidence (2026-11-17)

The confirmed Render workspace `Onro Rentals` (`tea-dailsph594qs7399sumg`) contained no Jevbox/knowledge web or worker in the service inventory. Its listed services were ControlRoom and telemetry services. None were changed. The repository includes Render and EKS templates, which do not establish a running target. Deployment remains blocked until the existing Jevbox URL/service IDs or EKS cluster/namespace and access are supplied. Do not instantiate the template as a substitute: it creates paid resources.

The user subsequently identified the existing target as Docker on `dashadmin@13.204.128.135`. This cloud execution environment cannot route to TCP port 22 (`Network is unreachable`), has no mounted SSH agent/keychain, and the GitHub CLI has no credentials. The GitHub integration rejected feature-branch creation with HTTP 403 `Resource not accessible by integration`. No deployment or remote branch was created. Reuse the user's authorized keychain from an execution environment that can reach this host; do not request or paste private keys into chat.

On that host, inspect only the existing Jevbox Docker/Compose project, record its current image and web/worker commands, back up its existing PostgreSQL database, and deploy the verified image to those same containers. Preserve existing volumes, network, secrets and non-Jevbox services. Set the sync flag false in the existing worker configuration; run the one-shot synthetic test-organization acceptance before enabling scheduling.

Citation scope: current search results retain Jevbox section/passage targets and include immutable GitHub revision provenance. Historical chat citations still follow Jevbox's existing stable-document behavior and are not immutable local revision archives; consult the captured GitHub permalink for the original revision. Live browser citation opening remains part of deployment acceptance.

## Validation evidence

The supplied ZIP application script was inspected and applied to feature branch `feat/onro-knowledge-steward` based on main `0cdb0b128463e6f12cb79d47ad93a94030b9a36d`, then adapted after independent review. Local TypeScript validation passed. The focused suite passed 24 tests using PostgreSQL 17.11 and SpiceDB 1.48.0 (temporary in-memory authorization, isolated PostgreSQL test schemas), including real pg-boss knowledge job completion/index processing, search section citation targets, duplicate events, cross-org isolation, failed updates, retirement/restoration, incomplete scans, stale findings, lost claims, retry fairness and download revision races. GitHub and model responses are synthetic; this is not production acceptance.

The broader Jevbox test suite was also exercised. Failures reproduced on unmodified main include a timezone-sensitive admin assertion, absent pinned Playwright browser, and a background-job timeout in a security test. The browser installer returned an invalid/truncated archive. Do not represent the entire suite or deployment acceptance as green until those environment/baseline failures are resolved in hosted CI or the existing deployment environment.

## Shared test database isolation

The default test command runs files serially. Each file still exercises its explicit
worker/concurrency assertions, but Better Auth schema discovery scans the shared
PostgreSQL catalog: another file dropping its disposable schema can otherwise
cause a transient `schema ... does not exist` error during authentication.
Use PostgreSQL-backed SpiceDB for the full matrix rather than a long-lived
in-memory test datastore; accumulated historical tuples can exhaust its memory
and invalidate results. The browser suites may run separately on a capable
host, but must remain part of the acceptance matrix.

## Connected-host follow-up (2026-11-17)

The earlier cloud access limitations above were resolved through the authorized
Mac SSH/GitHub session. PR #1 targets `main`. The existing deployment is the
`jevbox` Compose project at `/home/dashadmin/jevbox` on the user-identified host.
Its tracked source (excluding host-specific Compose configuration) matches the
inspected `main`; existing uncommitted deployment settings must be preserved.
A custom-format PostgreSQL backup was taken and its archive listing verified
before any deployment. The existing image is retained for rollback.

Worker-only credentials are read from the restricted `.env.knowledge-sync` file
via `compose.knowledge-steward.yaml`. Both web and worker explicitly force sync
off during acceptance. Do not put the GitHub token in web environment variables,
commit it, or copy broader GitHub CLI credentials to the server.

Test fixture corrections preserve assertions: administrative timestamps use
explicit UTC instants and the fake model returns schema-valid filing decisions.
The pinned-browser suites passed all 20 tests on the connected Mac. Full-suite
services must use disk-backed PostgreSQL: a tmpfs data directory counts against
the database container memory limit and invalidated earlier resource-constrained
runs. The streaming test passed after correcting that infrastructure.

The intended repositories are `OnroTech/ControlRoom` and
`OnroTech/OnroCustomerApps`. Restricted-token metadata checks currently return
404 for both, so real GitHub ingestion is not verified. A simulated source can
validate the deployed ingestion/index lifecycle without claiming real-source
access. Keep scheduling off until the token, reviewed non-PII documentation
scope, and real-source test ingestion have all been verified.

Final regression matrix: 290/290 core tests passed on isolated disk-backed
PostgreSQL 17 and PostgreSQL-backed SpiceDB 1.48.0, with zero failures,
cancellations or skips (356.53 seconds). Together with the 20/20 pinned-browser
tests, all 310 cases passed. TypeScript and Vite production build passed. GitHub
Actions had no run records at verification time; these are recorded execution
environment results, not a claim that hosted CI ran.
