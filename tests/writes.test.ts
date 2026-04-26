import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { createPage, appendToPage, appendInBody } from "../src/writes";
import { traceLineage } from "../src/lineage";
import { slugToPath } from "../src/paths";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `zbrain-w-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });
  mkdirSync(join(tmpHome, ".zbrain"), { recursive: true });
  process.env.ZBRAIN_HOME = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ZBRAIN_HOME;
});

const TEST_LINEAGE = {
  agent_id: "cc-4f2a",
  tool_call_id: "tc-001",
  orchestrator_session_id: "openclaw-9d11",
  parent_agent_id: "claw",
  spawn_chain: ["claw", "cc-4f2a"],
};

describe("createPage", () => {
  test("creates a new page on disk + index, writes lineage", async () => {
    const db = openDb(":memory:");
    const result = await createPage(db, {
      slug: "business/acme",
      type: "business",
      frontmatter: { name: "Acme Corp" },
      body: "Initial notes about Acme.",
      lineage: TEST_LINEAGE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("business/acme");
    expect(result.block_ords.length).toBeGreaterThan(0);

    // Disk
    const path = slugToPath("business/acme");
    expect(existsSync(path)).toBe(true);
    const fileText = readFileSync(path, "utf8");
    expect(fileText).toContain("name: Acme Corp");
    expect(fileText).toContain("type: business");
    expect(fileText).toContain("Initial notes about Acme.");

    // Index
    const page = db.prepare("SELECT * FROM pages WHERE slug = ?").get("business/acme") as any;
    expect(page.type).toBe("business");

    // Lineage
    const trace = traceLineage(db, "business/acme");
    expect(trace.length).toBe(1);
    expect(trace[0]!.agent_id).toBe("cc-4f2a");
    expect(trace[0]!.spawn_chain).toEqual(["claw", "cc-4f2a"]);
    db.close();
  });

  test("rejects invalid slug", async () => {
    const db = openDb(":memory:");
    const result = await createPage(db, {
      slug: "../escape",
      body: "x",
      lineage: TEST_LINEAGE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid slug");
    db.close();
  });

  test("rejects creating an existing page", async () => {
    const db = openDb(":memory:");
    await createPage(db, { slug: "p1", body: "first", lineage: TEST_LINEAGE });
    const second = await createPage(db, { slug: "p1", body: "again", lineage: TEST_LINEAGE });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already exists");
    db.close();
  });

  test("rejects agent writes to zbrain/dream-prompt", async () => {
    const db = openDb(":memory:");
    const result = await createPage(db, {
      slug: "zbrain/dream-prompt",
      body: "agent trying to overwrite system prompt",
      lineage: TEST_LINEAGE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("human-edit-only");
    db.close();
  });

  test("allows human writes to zbrain/dream-prompt", async () => {
    const db = openDb(":memory:");
    const humanLineage = {
      agent_id: "human",
      tool_call_id: "manual:1",
      orchestrator_session_id: "none",
      parent_agent_id: "none",
      spawn_chain: [],
    };
    const result = await createPage(db, {
      slug: "zbrain/dream-prompt",
      body: "approved human edit",
      lineage: humanLineage,
    });
    expect(result.ok).toBe(true);
    db.close();
  });

  test("nested slug creates nested directories on disk", async () => {
    const db = openDb(":memory:");
    const result = await createPage(db, {
      slug: "business/acme/q3-expansion",
      body: "Plan",
      lineage: TEST_LINEAGE,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(slugToPath("business/acme/q3-expansion"))).toBe(true);
    db.close();
  });
});

describe("appendToPage", () => {
  test("rejects writing to a non-existent page", async () => {
    const db = openDb(":memory:");
    const result = await appendToPage(db, {
      slug: "ghost",
      content: "hi",
      lineage: TEST_LINEAGE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
    db.close();
  });

  test("appends body content, updates index, writes lineage", async () => {
    const db = openDb(":memory:");
    await createPage(db, {
      slug: "biz/acme",
      type: "business",
      body: "Original line.",
      lineage: TEST_LINEAGE,
    });

    const result = await appendToPage(db, {
      slug: "biz/acme",
      content: "Sarah wants the upgrade tier.",
      lineage: { ...TEST_LINEAGE, tool_call_id: "tc-002" },
    });

    expect(result.ok).toBe(true);
    const file = readFileSync(slugToPath("biz/acme"), "utf8");
    expect(file).toContain("Original line.");
    expect(file).toContain("Sarah wants the upgrade tier.");

    const trace = traceLineage(db, "biz/acme");
    expect(trace.length).toBe(2);
    expect(trace[1]!.tool_call_id).toBe("tc-002");
    db.close();
  });

  test("with section, creates ## heading if missing", async () => {
    const db = openDb(":memory:");
    await createPage(db, { slug: "p", body: "Body.", lineage: TEST_LINEAGE });
    await appendToPage(db, {
      slug: "p",
      section: "2026-04-26",
      content: "Met with Sarah.",
      lineage: { ...TEST_LINEAGE, tool_call_id: "tc-002" },
    });
    const file = readFileSync(slugToPath("p"), "utf8");
    expect(file).toContain("## 2026-04-26");
    expect(file.indexOf("Met with Sarah.")).toBeGreaterThan(file.indexOf("## 2026-04-26"));
    db.close();
  });

  test("with section, appends under existing heading without duplicating", async () => {
    const db = openDb(":memory:");
    await createPage(db, {
      slug: "p",
      body: "## Notes\n\nFirst note.\n\n## Other\n\nUnrelated.",
      lineage: TEST_LINEAGE,
    });
    await appendToPage(db, {
      slug: "p",
      section: "Notes",
      content: "Second note.",
      lineage: { ...TEST_LINEAGE, tool_call_id: "tc-002" },
    });
    const file = readFileSync(slugToPath("p"), "utf8");
    // Both notes should be under ## Notes, before ## Other
    const notesIdx = file.indexOf("## Notes");
    const otherIdx = file.indexOf("## Other");
    const secondIdx = file.indexOf("Second note.");
    const firstIdx = file.indexOf("First note.");
    expect(notesIdx).toBeLessThan(firstIdx);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(otherIdx);
    db.close();
  });
});

describe("appendInBody (pure function)", () => {
  test("no section, empty body", () => {
    expect(appendInBody("", undefined, "first")).toBe("first\n");
  });

  test("no section, existing body adds blank-line separator", () => {
    expect(appendInBody("Hello.", undefined, "World.")).toBe("Hello.\n\nWorld.\n");
  });

  test("section missing creates heading at end", () => {
    const out = appendInBody("Body.", "Day 1", "first day");
    expect(out).toContain("## Day 1");
    expect(out.indexOf("first day")).toBeGreaterThan(out.indexOf("## Day 1"));
  });

  test("section exists, new content appended below it before next ##", () => {
    const body = "## A\n\none\n\n## B\n\ntwo";
    const out = appendInBody(body, "A", "extra");
    const aIdx = out.indexOf("## A");
    const bIdx = out.indexOf("## B");
    const oneIdx = out.indexOf("one");
    const extraIdx = out.indexOf("extra");
    expect(aIdx).toBeLessThan(oneIdx);
    expect(oneIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(bIdx);
  });

  test("special regex chars in section name are escaped", () => {
    const body = "## A.B (test)\n\nfirst";
    const out = appendInBody(body, "A.B (test)", "second");
    expect(out).toContain("first");
    expect(out).toContain("second");
    // Should not duplicate the heading.
    expect(out.match(/## A\.B \(test\)/g)?.length).toBe(1);
  });

  test("empty content is a no-op", () => {
    expect(appendInBody("hello", undefined, "")).toBe("hello");
    expect(appendInBody("hello", undefined, "   ")).toBe("hello");
  });
});
