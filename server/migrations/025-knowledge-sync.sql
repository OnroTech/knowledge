-- Additive migration; no existing resources or queues are rewritten.
CREATE TABLE knowledge_source_manifest (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  resource_id TEXT NOT NULL UNIQUE,
  revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retired','pending')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,source_key),
  FOREIGN KEY(resource_id,org_id) REFERENCES resources(id,org_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_source_manifest_org ON knowledge_source_manifest(org_id,state);
CREATE TABLE knowledge_sync_findings (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,source_key,kind)
);
