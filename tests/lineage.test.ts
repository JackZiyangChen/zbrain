import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { openDb } from "../src/db";
import {
  validateLineage,
  sentinelLineage,
  writeLineage,
  traceLineage,
} from "../src/lineage";

const SAVE_KEYS = [
  "ZBRAIN_ORCHESTRATOR_SESSION_ID",
  "ZBRAIN_PARENT_AGENT_ID",
  "ZBRAIN_SPAWN_CHAIN",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of SAVE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SAVE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("validateLineage", () => {
  test("rejects missing input", () => {
    expect(validateLineage(undefined).ok).toBe(false);
    expect(validateLineage(null as any).ok).toBe(false);
    expect((validateLineage({}).ok ? "" : (validateLineage({}) as any).error)).toContain("agent_id");
  });

  test("rejects empty agent_id", () => {
    const result = validateLineage({ agent_id: "", tool_call_id: "tc-1" });
    expect(result.ok).toBe(false);
  });

  test("rejects missing tool_call_id", () => {
    const result = validateLineage({ agent_id: "cc-4f2a" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("tool_call_id");
  });

  test("accepts minimal valid input, fills defaults from env", () => {
    process.env.ZBRAIN_ORCHESTRATOR_SESSION_ID = "openclaw-9d11";
    process.env.ZBRAIN_PARENT_AGENT_ID = "claw";
    const r = validateLineage({ agent_id: "cc-4f2a", tool_call_id: "tc-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.agent_id).toBe("cc-4f2a");
      expect(r.meta.orchestrator_session_id).toBe("openclaw-9d11");
      expect(r.meta.parent_agent_id).toBe("claw");
      expect(r.meta.spawn_chain).toEqual([]);
    }
  });

  test("env spawn_chain JSON parsed", () => {
    process.env.ZBRAIN_SPAWN_CHAIN = '["openclaw-9d11","claude-code-4f2a"]';
    const r = validateLineage({ agent_id: "cc", tool_call_id: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.spawn_chain).toEqual(["openclaw-9d11", "claude-code-4f2a"]);
  });

  test("env spawn_chain falls back to comma-separated parse", () => {
    process.env.ZBRAIN_SPAWN_CHAIN = "claw, claude-code-4f2a, websearch-ab2c";
    const r = validateLineage({ agent_id: "cc", tool_call_id: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.spawn_chain).toEqual(["claw", "claude-code-4f2a", "websearch-ab2c"]);
  });

  test("explicit lineage args override env defaults", () => {
    process.env.ZBRAIN_ORCHESTRATOR_SESSION_ID = "env-sid";
    const r = validateLineage({
      agent_id: "cc",
      tool_call_id: "t",
      orchestrator_session_id: "explicit-sid",
      parent_agent_id: "explicit-parent",
      spawn_chain: ["a", "b"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.orchestrator_session_id).toBe("explicit-sid");
      expect(r.meta.parent_agent_id).toBe("explicit-parent");
      expect(r.meta.spawn_chain).toEqual(["a", "b"]);
    }
  });

  test("missing env vars default to 'none' sentinels", () => {
    const r = validateLineage({ agent_id: "cc", tool_call_id: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.orchestrator_session_id).toBe("none");
      expect(r.meta.parent_agent_id).toBe("none");
      expect(r.meta.spawn_chain).toEqual([]);
    }
  });
});

describe("sentinelLineage", () => {
  test("builds a 'human' sentinel", () => {
    const meta = sentinelLineage({ agent_id: "human", tool_call_id: "reindex:1700" });
    expect(meta.agent_id).toBe("human");
    expect(meta.tool_call_id).toBe("reindex:1700");
    expect(meta.orchestrator_session_id).toBe("none");
  });

  test("builds an 'openclaw-watcher' sentinel with parent='claw'", () => {
    const meta = sentinelLineage({
      agent_id: "openclaw-watcher",
      tool_call_id: "watcher:1700",
      parent_agent_id: "claw",
      spawn_chain: ["claw"],
    });
    expect(meta.agent_id).toBe("openclaw-watcher");
    expect(meta.parent_agent_id).toBe("claw");
    expect(meta.spawn_chain).toEqual(["claw"]);
  });
});

describe("writeLineage + traceLineage", () => {
  test("writes and retrieves lineage rows in time order", () => {
    const db = openDb(":memory:");
    // Need a pages row for FK-friendly behavior (lineage doesn't have FK but
    // we want realistic data shape).
    db.prepare(
      "INSERT INTO pages(slug, type, frontmatter_json, body, body_sha, updated_at) VALUES(?,?,?,?,?,?)",
    ).run("biz/acme", "business", "{}", "body", "sha", 1700);

    writeLineage(db, {
      page_slug: "biz/acme",
      block_ord: -1,
      meta: {
        agent_id: "cc-4f2a",
        tool_call_id: "tc-001",
        orchestrator_session_id: "openclaw-9d11",
        parent_agent_id: "claw",
        spawn_chain: ["claw", "cc-4f2a"],
      },
      ts: 1700,
    });
    writeLineage(db, {
      page_slug: "biz/acme",
      block_ord: 2,
      meta: {
        agent_id: "websearch-ab2c",
        tool_call_id: "tc-002",
        orchestrator_session_id: "openclaw-9d11",
        parent_agent_id: "cc-4f2a",
        spawn_chain: ["claw", "cc-4f2a", "websearch-ab2c"],
      },
      ts: 1800,
    });

    const trace = traceLineage(db, "biz/acme");
    expect(trace.length).toBe(2);
    expect(trace[0]!.agent_id).toBe("cc-4f2a");
    expect(trace[0]!.spawn_chain).toEqual(["claw", "cc-4f2a"]);
    expect(trace[1]!.agent_id).toBe("websearch-ab2c");
    expect(trace[1]!.spawn_chain).toEqual(["claw", "cc-4f2a", "websearch-ab2c"]);
    db.close();
  });

  test("`since` filter excludes older rows", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO pages(slug, type, frontmatter_json, body, body_sha, updated_at) VALUES(?,?,?,?,?,?)",
    ).run("p", null, "{}", "", "", 1000);
    writeLineage(db, { page_slug: "p", block_ord: 0, meta: sentinelLineage({ agent_id: "human", tool_call_id: "a" }), ts: 1000 });
    writeLineage(db, { page_slug: "p", block_ord: 0, meta: sentinelLineage({ agent_id: "human", tool_call_id: "b" }), ts: 2000 });

    const all = traceLineage(db, "p");
    expect(all.length).toBe(2);

    const recent = traceLineage(db, "p", 1500);
    expect(recent.length).toBe(1);
    expect(recent[0]!.tool_call_id).toBe("b");
    db.close();
  });

  test("empty result for unknown page", () => {
    const db = openDb(":memory:");
    expect(traceLineage(db, "no-such-page")).toEqual([]);
    db.close();
  });

  test("malformed spawn_chain_json yields empty array, no throw", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO lineage(page_slug, block_ord, orchestrator_session_id, agent_id, parent_agent_id, spawn_chain_json, tool_call_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("p", -1, "none", "human", "none", "{ broken json", "tc", 1000);
    const trace = traceLineage(db, "p");
    expect(trace.length).toBe(1);
    expect(trace[0]!.spawn_chain).toEqual([]);
    db.close();
  });
});
