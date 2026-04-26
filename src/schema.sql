-- zbrain schema. Versioned via PRAGMA user_version.
-- Apply via openDb() bootstrap in src/db.ts (idempotent: CREATE IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- =====================================================================
-- pages: ONE row per markdown file. type is a soft tag, not a constraint.
-- =====================================================================
CREATE TABLE IF NOT EXISTS pages (
  slug             TEXT PRIMARY KEY,
  type             TEXT,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  body             TEXT NOT NULL DEFAULT '',
  body_sha         TEXT,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_type       ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at);

-- =====================================================================
-- blocks: paragraph-level chunks of a page body. embedding_model
-- defaults to 'pending'; embed-queue picks up rows where it's pending.
-- =====================================================================
CREATE TABLE IF NOT EXISTS blocks (
  block_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug       TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  text            TEXT NOT NULL,
  text_sha        TEXT NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'pending',
  updated_at      INTEGER NOT NULL,
  UNIQUE(page_slug, ord)
);

CREATE INDEX IF NOT EXISTS idx_blocks_page    ON blocks(page_slug, ord);
CREATE INDEX IF NOT EXISTS idx_blocks_pending ON blocks(embedding_model)
  WHERE embedding_model = 'pending';

-- =====================================================================
-- blocks_vec: vector index. INVARIANT: blocks_vec.rowid == blocks.block_id.
-- Maintained by the indexer in the same transaction as the blocks insert.
-- vec0 doesn't support FK or triggers; doctor verifies parity.
-- =====================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_vec USING vec0(
  embedding float[1536]
);

-- =====================================================================
-- lineage: provenance per write. agent_id REQUIRED, tool_call_id REQUIRED.
-- Sentinel values: agent_id="human" for manual edits caught by reindex,
-- agent_id="openclaw-watcher" for OpenClaw memory bridge ingests,
-- agent_id="dream" for dream-process writes,
-- agent_id="dream-review" for accepted dream proposals.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lineage (
  write_id                INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug               TEXT NOT NULL,
  block_ord               INTEGER NOT NULL DEFAULT -1,
  orchestrator_session_id TEXT NOT NULL DEFAULT 'none',
  agent_id                TEXT NOT NULL,
  parent_agent_id         TEXT NOT NULL DEFAULT 'none',
  spawn_chain_json        TEXT NOT NULL DEFAULT '[]',
  tool_call_id            TEXT NOT NULL,
  ts                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lineage_page ON lineage(page_slug, ts);
CREATE INDEX IF NOT EXISTS idx_lineage_agent ON lineage(agent_id, ts);

-- =====================================================================
-- meta: simple key-value store for runtime config + migrations.
-- =====================================================================
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Schema version. Bumped on schema migrations. v1 = 1.
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
