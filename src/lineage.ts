/**
 * Lineage validation, env-var merge, and trace_lineage retrieval.
 *
 * Per the design doc:
 *   - agent_id     REQUIRED (non-empty string). Sentinel "human" allowed for
 *                  reindex-detected manual edits; "openclaw-watcher" for the
 *                  bridge; "dream" for the dream process; "dream-review"
 *                  for accepted dream proposals.
 *   - tool_call_id REQUIRED (non-empty string). Sentinel "none" allowed
 *                  paired with agent_id="human".
 *   - orchestrator_session_id, parent_agent_id, spawn_chain
 *                  optional; merged from env vars on the server side
 *                  (ZBRAIN_ORCHESTRATOR_SESSION_ID, etc.) when not provided
 *                  by the agent.
 *
 * Validation runs on every create_page / append_to_page. A bad lineage
 * shape rejects the write (no partial state).
 */
import type { Database } from "bun:sqlite";

export type LineageMetaInput = {
  agent_id?: unknown;
  tool_call_id?: unknown;
  orchestrator_session_id?: unknown;
  parent_agent_id?: unknown;
  spawn_chain?: unknown;
};

export type LineageMeta = {
  agent_id: string;
  tool_call_id: string;
  orchestrator_session_id: string;
  parent_agent_id: string;
  spawn_chain: string[];
};

export type ValidationResult =
  | { ok: true; meta: LineageMeta }
  | { ok: false; error: string };

const SENTINEL_NONE = "none";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Read env-var defaults for the server-injected lineage fields.
 * Called per request so unit tests can override via process.env.
 */
function envDefaults(): Pick<LineageMeta, "orchestrator_session_id" | "parent_agent_id" | "spawn_chain"> {
  const env = process.env;
  let spawn_chain: string[] = [];
  const rawChain = env.ZBRAIN_SPAWN_CHAIN;
  if (rawChain) {
    try {
      const parsed = JSON.parse(rawChain);
      if (isStringArray(parsed)) spawn_chain = parsed;
    } catch {
      // Allow comma-separated as a fallback for orchestrators that don't JSON-encode.
      spawn_chain = rawChain.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return {
    orchestrator_session_id: env.ZBRAIN_ORCHESTRATOR_SESSION_ID ?? SENTINEL_NONE,
    parent_agent_id: env.ZBRAIN_PARENT_AGENT_ID ?? SENTINEL_NONE,
    spawn_chain,
  };
}

/**
 * Validate and normalize a lineage_meta argument from an MCP tool call.
 * Required: agent_id, tool_call_id (both non-empty strings).
 * Optional: orchestrator_session_id, parent_agent_id, spawn_chain
 *           (caller may override the env-var defaults).
 */
export function validateLineage(input: LineageMetaInput | undefined | null): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "missing required field: lineage_meta" };
  }

  if (!isNonEmptyString(input.agent_id)) {
    return { ok: false, error: "missing required lineage field: agent_id (non-empty string)" };
  }
  if (!isNonEmptyString(input.tool_call_id)) {
    return { ok: false, error: "missing required lineage field: tool_call_id (non-empty string)" };
  }

  const defaults = envDefaults();
  const orchestrator_session_id = isNonEmptyString(input.orchestrator_session_id)
    ? input.orchestrator_session_id
    : defaults.orchestrator_session_id;
  const parent_agent_id = isNonEmptyString(input.parent_agent_id)
    ? input.parent_agent_id
    : defaults.parent_agent_id;
  const spawn_chain = isStringArray(input.spawn_chain)
    ? input.spawn_chain
    : defaults.spawn_chain;

  return {
    ok: true,
    meta: {
      agent_id: input.agent_id,
      tool_call_id: input.tool_call_id,
      orchestrator_session_id,
      parent_agent_id,
      spawn_chain,
    },
  };
}

/**
 * Build a sentinel lineage record for non-agent writes (reindex of human edits,
 * file watcher bridge, dream process, etc.). These bypass the
 * agent_id-must-be-set check because they ARE the system writing on behalf
 * of a non-agent source.
 */
export function sentinelLineage(opts: {
  agent_id: "human" | "openclaw-watcher" | "dream" | "dream-review";
  tool_call_id: string;
  parent_agent_id?: string;
  spawn_chain?: string[];
}): LineageMeta {
  return {
    agent_id: opts.agent_id,
    tool_call_id: opts.tool_call_id,
    orchestrator_session_id: SENTINEL_NONE,
    parent_agent_id: opts.parent_agent_id ?? SENTINEL_NONE,
    spawn_chain: opts.spawn_chain ?? [],
  };
}

/**
 * Insert a lineage row. Used by every write path (MCP, reindex, watcher,
 * dream). block_ord = -1 indicates a frontmatter-only or page-level write.
 */
export function writeLineage(
  db: Database,
  args: {
    page_slug: string;
    block_ord: number;
    meta: LineageMeta;
    ts?: number;
  },
): number {
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO lineage(
         page_slug, block_ord,
         orchestrator_session_id, agent_id, parent_agent_id,
         spawn_chain_json, tool_call_id, ts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.page_slug,
      args.block_ord,
      args.meta.orchestrator_session_id,
      args.meta.agent_id,
      args.meta.parent_agent_id,
      JSON.stringify(args.meta.spawn_chain),
      args.meta.tool_call_id,
      ts,
    );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// trace_lineage — the demo flex.
// ---------------------------------------------------------------------------

export type LineageEntry = {
  block_ord: number;
  agent_id: string;
  parent_agent_id: string;
  orchestrator_session_id: string;
  spawn_chain: string[];
  tool_call_id: string;
  ts: number;
};

export function traceLineage(
  db: Database,
  slug: string,
  since?: number,
): LineageEntry[] {
  const rows = since
    ? (db
        .prepare(
          `SELECT block_ord, agent_id, parent_agent_id, orchestrator_session_id,
                  spawn_chain_json, tool_call_id, ts
             FROM lineage
            WHERE page_slug = ? AND ts >= ?
            ORDER BY ts ASC`,
        )
        .all(slug, since) as Array<{
        block_ord: number;
        agent_id: string;
        parent_agent_id: string;
        orchestrator_session_id: string;
        spawn_chain_json: string;
        tool_call_id: string;
        ts: number;
      }>)
    : (db
        .prepare(
          `SELECT block_ord, agent_id, parent_agent_id, orchestrator_session_id,
                  spawn_chain_json, tool_call_id, ts
             FROM lineage
            WHERE page_slug = ?
            ORDER BY ts ASC`,
        )
        .all(slug) as Array<{
        block_ord: number;
        agent_id: string;
        parent_agent_id: string;
        orchestrator_session_id: string;
        spawn_chain_json: string;
        tool_call_id: string;
        ts: number;
      }>);

  return rows.map((r) => {
    let spawn_chain: string[] = [];
    try {
      const parsed = JSON.parse(r.spawn_chain_json);
      if (isStringArray(parsed)) spawn_chain = parsed;
    } catch {
      // ignore malformed chain
    }
    return {
      block_ord: r.block_ord,
      agent_id: r.agent_id,
      parent_agent_id: r.parent_agent_id,
      orchestrator_session_id: r.orchestrator_session_id,
      spawn_chain,
      tool_call_id: r.tool_call_id,
      ts: r.ts,
    };
  });
}
