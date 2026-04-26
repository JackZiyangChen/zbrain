import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { indexParsed, indexBySlug, parseFile, reindexAll, sha256 } from "../src/indexer";
import { pagesDir, slugToPath } from "../src/paths";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `zbrain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });
  mkdirSync(join(tmpHome, ".zbrain"), { recursive: true });
  process.env.ZBRAIN_HOME = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ZBRAIN_HOME;
});

describe("parseFile", () => {
  test("parses frontmatter + body", () => {
    const file = join(tmpHome, "pages", "test.md");
    writeFileSync(file, `---\ntype: business\nname: Acme\n---\n\nHello world.\n`);
    const parsed = parseFile("test", file);
    expect(parsed.slug).toBe("test");
    expect(parsed.type).toBe("business");
    expect((parsed.frontmatter as any).name).toBe("Acme");
    expect(parsed.body.trim()).toBe("Hello world.");
    expect(parsed.bodySha).toBe(sha256(parsed.body));
  });

  test("handles no frontmatter", () => {
    const file = join(tmpHome, "pages", "plain.md");
    writeFileSync(file, "Just a body.");
    const parsed = parseFile("plain", file);
    expect(parsed.type).toBe(null);
    expect(parsed.body.trim()).toBe("Just a body.");
  });

  test("type is null when frontmatter has no type field", () => {
    const file = join(tmpHome, "pages", "untyped.md");
    writeFileSync(file, `---\nname: thing\n---\nbody`);
    const parsed = parseFile("untyped", file);
    expect(parsed.type).toBe(null);
  });
});

describe("indexParsed", () => {
  test("inserts a new page + blocks", () => {
    const db = openDb(":memory:");
    const result = indexParsed(db, {
      slug: "business/acme",
      type: "business",
      frontmatter: { name: "Acme" },
      body: "First paragraph.\n\nSecond paragraph.",
      bodySha: sha256("First paragraph.\n\nSecond paragraph."),
    });
    expect(result).toBe("inserted");

    const page = db.prepare("SELECT * FROM pages WHERE slug = ?").get("business/acme") as any;
    expect(page.type).toBe("business");
    expect(JSON.parse(page.frontmatter_json).name).toBe("Acme");

    const blocks = db.prepare("SELECT * FROM blocks WHERE page_slug = ? ORDER BY ord").all("business/acme") as any[];
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("First paragraph.");
    expect(blocks[1].text).toBe("Second paragraph.");
    expect(blocks[0].embedding_model).toBe("pending");
    db.close();
  });

  test("unchanged body is a no-op", () => {
    const db = openDb(":memory:");
    const body = "stable body.";
    const parsed = {
      slug: "stable",
      type: null,
      frontmatter: {},
      body,
      bodySha: sha256(body),
    };
    expect(indexParsed(db, parsed)).toBe("inserted");
    expect(indexParsed(db, parsed)).toBe("unchanged");
    db.close();
  });

  test("body change updates the page and re-chunks blocks", () => {
    const db = openDb(":memory:");
    indexParsed(db, {
      slug: "evolving",
      type: null,
      frontmatter: {},
      body: "v1 paragraph.",
      bodySha: sha256("v1 paragraph."),
    });
    const result = indexParsed(db, {
      slug: "evolving",
      type: null,
      frontmatter: {},
      body: "v2 first.\n\nv2 second.",
      bodySha: sha256("v2 first.\n\nv2 second."),
    });
    expect(result).toBe("updated");
    const blocks = db.prepare("SELECT text FROM blocks WHERE page_slug = ? ORDER BY ord").all("evolving") as any[];
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("v2 first.");
    expect(blocks[1].text).toBe("v2 second.");
    db.close();
  });
});

describe("reindexAll", () => {
  test("scans pages/, indexes new files, reports correctly", async () => {
    writeFileSync(join(tmpHome, "pages", "first.md"), "---\ntype: thought\n---\nFirst content.");
    mkdirSync(join(tmpHome, "pages", "business"), { recursive: true });
    writeFileSync(join(tmpHome, "pages", "business", "acme.md"), "---\ntype: business\n---\nAcme stuff.");

    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const report = await reindexAll(db);

    expect(report.scanned).toBe(2);
    expect(report.inserted.sort()).toEqual(["business/acme", "first"]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual([]);

    const pages = db.prepare("SELECT slug, type FROM pages ORDER BY slug").all() as any[];
    expect(pages.map((p) => p.slug)).toEqual(["business/acme", "first"]);
    db.close();
  });

  test("orphan cleanup deletes pages whose files are missing", async () => {
    const file = join(tmpHome, "pages", "ephemeral.md");
    writeFileSync(file, "soon to vanish.");
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));

    let report = await reindexAll(db);
    expect(report.inserted).toEqual(["ephemeral"]);

    rmSync(file);
    report = await reindexAll(db);
    expect(report.deleted).toEqual(["ephemeral"]);
    const remaining = db.prepare("SELECT slug FROM pages").all() as any[];
    expect(remaining).toEqual([]);
    db.close();
  });

  test("hidden directories are skipped", async () => {
    mkdirSync(join(tmpHome, "pages", ".trash"), { recursive: true });
    writeFileSync(join(tmpHome, "pages", ".trash", "junk.md"), "trashed");
    writeFileSync(join(tmpHome, "pages", "real.md"), "real content");

    const db = openDb(join(tmpHome, ".zbrain", "index.db"));
    const report = await reindexAll(db);

    expect(report.inserted).toEqual(["real"]);
    db.close();
  });

  test("re-running reindex on unchanged tree reports unchanged", async () => {
    writeFileSync(join(tmpHome, "pages", "stable.md"), "still here");
    const db = openDb(join(tmpHome, ".zbrain", "index.db"));

    let report = await reindexAll(db);
    expect(report.inserted).toEqual(["stable"]);

    report = await reindexAll(db);
    expect(report.unchanged).toEqual(["stable"]);
    expect(report.inserted).toEqual([]);
    expect(report.updated).toEqual([]);
    db.close();
  });
});

describe("indexBySlug", () => {
  test("indexes a file by slug after disk write", () => {
    const path = slugToPath("business/contoso");
    mkdirSync(join(tmpHome, "pages", "business"), { recursive: true });
    writeFileSync(path, "---\ntype: business\n---\nContoso stuff.");

    const db = openDb(":memory:");
    const result = indexBySlug(db, "business/contoso");
    expect(result).toBe("inserted");

    const page = db.prepare("SELECT * FROM pages WHERE slug = ?").get("business/contoso") as any;
    expect(page.type).toBe("business");
    db.close();
  });

  test("returns 'missing' if file does not exist", () => {
    const db = openDb(":memory:");
    expect(indexBySlug(db, "nonexistent")).toBe("missing");
    db.close();
  });
});
