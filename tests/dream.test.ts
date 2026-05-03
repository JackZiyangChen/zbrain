import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { createPage } from "../src/writes";
import {
  runDream,
  parseProposals,
  loadProposals,
  saveProposals,
  applyProposal,
  type DreamProposal,
} from "../src/dream";
import { dreamProposalsDir, slugToPath } from "../src/paths";

const SAVED_ENV = ["ZBRAIN_DREAM_LLM", "ZBRAIN_HOME"];
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = {};
  for (const k of SAVED_ENV) {
    saved[k] = process.env[k];
  }
  tmpHome = join(tmpdir(), `zbrain-d-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages", "zbrain"), { recursive: true });
  mkdirSync(join(tmpHome, ".zbrain"), { recursive: true });
  process.env.ZBRAIN_HOME = tmpHome;
  process.env.ZBRAIN_DREAM_LLM = "fake";

  // Seed the dream-prompt page so runDream has a system prompt.
  writeFileSync(
    slugToPath("zbrain/dream-prompt"),
    `---\ntype: zbrain-system\n---\n\nYou are a fake dreamer. Output the standard sections and propose any updates as PROPOSE: lines.`,
  );
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  for (const k of SAVED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const TEST_LINEAGE = {
  agent_id: "cc-4f2a",
  tool_call_id: "tc-001",
  orchestrator_session_id: "openclaw-9d11",
  parent_agent_id: "claw",
  spawn_chain: ["claw", "cc-4f2a"],
};

describe("parseProposals", () => {
  test("returns [] when no PROPOSE: lines present", () => {
    expect(parseProposals("## Summary\nNothing to propose.")).toEqual([]);
  });

  test("parses single-line proposals", () => {
    const text = `## Summary\nstuff\n\nPROPOSE: append to business/acme — Sarah deadline — She wants Tuesday.\nPROPOSE: append to trading/k — vol spike — Spike noticed at close.`;
    const out = parseProposals(text);
    expect(out.length).toBe(2);
    expect(out[0]!.slug).toBe("business/acme");
    expect(out[0]!.reason).toBe("Sarah deadline");
    expect(out[0]!.content).toContain("She wants Tuesday.");
    expect(out[0]!.idx).toBe(0);
    expect(out[1]!.slug).toBe("trading/k");
    expect(out[1]!.idx).toBe(1);
  });

  test("multi-line proposal content trims correctly", () => {
    const text = `PROPOSE: append to a — first reason — first body line\nfirst body cont.\n\nPROPOSE: append to b — second reason — second body line`;
    const out = parseProposals(text);
    expect(out.length).toBe(2);
    expect(out[0]!.content).toContain("first body line");
    expect(out[0]!.content).toContain("first body cont.");
    expect(out[1]!.content).toBe("second body line");
  });

  test("ignores malformed PROPOSE-like lines without the em-dash structure", () => {
    const text = `PROPOSE: do something else\nPROPOSE: append to slug only`;
    const out = parseProposals(text);
    expect(out).toEqual([]);
  });
});

describe("runDream", () => {
  test("empty day produces a dream page + proposals file (deterministic via fake LLM)", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const result = await runDream(db, { date: "2026-04-26", now: 1745625600 });

    expect(result.date).toBe("2026-04-26");
    expect(result.dream_slug).toBe("dream/2026-04-26");
    expect(existsSync(slugToPath(result.dream_slug))).toBe(true);
    expect(existsSync(result.proposals_path)).toBe(true);
    expect(result.truncated).toBe(false);

    const dreamFile = readFileSync(slugToPath(result.dream_slug), "utf8");
    expect(dreamFile).toContain("type: dream");
    expect(dreamFile).toContain("## Summary");
    // PROPOSE: lines stripped from the body.
    expect(dreamFile).not.toContain("PROPOSE:");

    // Proposals file is JSON array (empty since no pages were touched).
    const proposals = JSON.parse(readFileSync(result.proposals_path, "utf8"));
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBe(0);

    db.close();
  });

  test("active day with multiple writes produces proposals derived from touched pages", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    // Simulate a day's activity: two pages written by an agent.
    const now = Math.floor(Date.now() / 1000);
    await createPage(db, {
      slug: "business/acme",
      type: "business",
      body: "Initial Acme notes.",
      lineage: TEST_LINEAGE,
    });
    await createPage(db, {
      slug: "trading/kalshi",
      type: "trading",
      body: "Kalshi vol thesis draft.",
      lineage: { ...TEST_LINEAGE, tool_call_id: "tc-002" },
    });

    const result = await runDream(db, { date: "2026-04-26", now });
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    // Fake LLM proposes against the slugs it sees in the prompt.
    const slugs = result.proposals.map((p) => p.slug);
    expect(slugs).toContain("business/acme");

    // Each proposal has the expected shape.
    for (const p of result.proposals) {
      expect(p.status).toBe("pending");
      expect(typeof p.idx).toBe("number");
      expect(p.content.length).toBeGreaterThan(0);
    }
    db.close();
  });

  test("dream page is attributed with agent_id='dream' lineage", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const result = await runDream(db, { date: "2026-04-26" });
    const trace = db
      .prepare("SELECT agent_id, tool_call_id FROM lineage WHERE page_slug = ?")
      .all(result.dream_slug) as Array<{ agent_id: string; tool_call_id: string }>;
    expect(trace.length).toBe(1);
    expect(trace[0]!.agent_id).toBe("dream");
    expect(trace[0]!.tool_call_id).toBe("dream:2026-04-26");
    db.close();
  });

  test("re-running on the same date suffixes the new dream page (no overwrite)", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const r1 = await runDream(db, { date: "2026-04-26" });
    const r2 = await runDream(db, { date: "2026-04-26" });
    expect(r1.dream_slug).toBe("dream/2026-04-26");
    expect(r2.dream_slug).toBe("dream/2026-04-26-2");
    expect(existsSync(slugToPath(r1.dream_slug))).toBe(true);
    expect(existsSync(slugToPath(r2.dream_slug))).toBe(true);
    db.close();
  });

  test("frontmatter records llm model + token usage + truncation flag", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const result = await runDream(db, { date: "2026-04-26" });
    const dreamFile = readFileSync(slugToPath(result.dream_slug), "utf8");
    expect(dreamFile).toContain("llm_model: fake");
    expect(dreamFile).toContain("truncated: false");
    expect(dreamFile).toMatch(/input_tokens:\s*\d+/);
    db.close();
  });

  test("missing dream-prompt page surfaces a clear error", async () => {
    rmSync(slugToPath("zbrain/dream-prompt"));
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    let err: any;
    try {
      await runDream(db, { date: "2026-04-26" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err.message)).toContain("dream prompt missing");
    db.close();
  });
});

describe("loadProposals / saveProposals", () => {
  test("roundtrip", () => {
    const proposals: DreamProposal[] = [
      { slug: "a", reason: "r1", content: "c1", idx: 0, status: "pending" },
      { slug: "b", reason: "r2", content: "c2", idx: 1, status: "rejected" },
    ];
    saveProposals("2026-04-26", proposals);
    const back = loadProposals("2026-04-26");
    expect(back).toEqual(proposals);
    // File path is what dream.ts wrote
    expect(existsSync(join(dreamProposalsDir(), "2026-04-26.json"))).toBe(true);
  });

  test("loadProposals returns [] for missing date", () => {
    expect(loadProposals("1900-01-01")).toEqual([]);
  });
});

describe("applyProposal", () => {
  test("appends to the target page with dream-review lineage", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    await createPage(db, {
      slug: "business/acme",
      type: "business",
      body: "Original Acme body.",
      lineage: TEST_LINEAGE,
    });

    const proposal: DreamProposal = {
      slug: "business/acme",
      reason: "consolidation",
      content: "Sarah will follow up Tuesday.",
      idx: 0,
      status: "pending",
    };

    const result = await applyProposal(db, "2026-04-26", proposal);
    expect(result.ok).toBe(true);

    // Lineage row attributing it to dream-review.
    const trace = db
      .prepare(
        "SELECT agent_id, tool_call_id, parent_agent_id, spawn_chain_json FROM lineage WHERE page_slug = ? ORDER BY ts ASC",
      )
      .all("business/acme") as Array<{
      agent_id: string;
      tool_call_id: string;
      parent_agent_id: string;
      spawn_chain_json: string;
    }>;
    const last = trace[trace.length - 1]!;
    expect(last.agent_id).toBe("dream-review");
    expect(last.tool_call_id).toBe("dream-review:2026-04-26:0");
    expect(last.parent_agent_id).toBe("dream");
    expect(JSON.parse(last.spawn_chain_json)).toEqual(["dream", "dream-review"]);

    // The page body now contains the proposal content.
    const file = readFileSync(slugToPath("business/acme"), "utf8");
    expect(file).toContain("Sarah will follow up Tuesday.");

    db.close();
  });

  test("applying a proposal whose target page no longer exists returns an error", async () => {
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const proposal: DreamProposal = {
      slug: "ghost-page",
      reason: "r",
      content: "c",
      idx: 0,
      status: "pending",
    };
    const result = await applyProposal(db, "2026-04-26", proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
    db.close();
  });
});
