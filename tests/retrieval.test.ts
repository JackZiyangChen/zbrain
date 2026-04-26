import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { indexParsed, sha256 } from "../src/indexer";
import { getPage, listPages, searchMemory } from "../src/retrieval";
import type { Database } from "bun:sqlite";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `zbrain-ret-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });
  mkdirSync(join(tmpHome, ".zbrain"), { recursive: true });
  process.env.ZBRAIN_HOME = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ZBRAIN_HOME;
});

function seed(db: Database, slug: string, type: string | null, frontmatter: any, body: string, ts?: number) {
  indexParsed(
    db,
    {
      slug,
      type,
      frontmatter,
      body,
      bodySha: sha256(body),
    },
    ts,
  );
}

/** Insert a synthetic embedding for a block (Float32Array of given length 1536). */
function setEmbedding(db: Database, blockId: number, vec: Float32Array, model = "test") {
  db.prepare("UPDATE blocks SET embedding_model = ? WHERE block_id = ?").run(model, blockId);
  db.prepare("INSERT INTO blocks_vec(rowid, embedding) VALUES (?, ?)").run(
    blockId,
    new Uint8Array(vec.buffer),
  );
}

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) {
    // deterministic, small variation by seed
    v[i] = Math.sin(i * 0.01 + seed) * 0.1;
  }
  return v;
}

describe("getPage", () => {
  test("returns null for missing slug", () => {
    const db = openDb(":memory:");
    expect(getPage(db, "no-such-page")).toBeNull();
    db.close();
  });

  test("returns frontmatter, body, type, updated_at", () => {
    const db = openDb(":memory:");
    seed(db, "business/acme", "business", { name: "Acme", status: "active" }, "Body text.", 1700000000);
    const result = getPage(db, "business/acme");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("business/acme");
    expect(result!.type).toBe("business");
    expect((result!.frontmatter as any).name).toBe("Acme");
    expect(result!.body).toBe("Body text.");
    expect(result!.updated_at).toBe(1700000000);
    expect(result!.links_outbound).toEqual([]);
    db.close();
  });

  test("malformed frontmatter_json yields empty frontmatter, no throw", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO pages(slug, type, frontmatter_json, body, body_sha, updated_at) VALUES(?,?,?,?,?,?)",
    ).run("broken", null, "{ not valid json", "body", "sha", 1700000000);
    const result = getPage(db, "broken");
    expect(result!.frontmatter).toEqual({});
    expect(result!.body).toBe("body");
    db.close();
  });
});

describe("listPages", () => {
  test("returns all pages by default, ordered by updated_at desc", () => {
    const db = openDb(":memory:");
    seed(db, "old", "thought", {}, "old", 1000);
    seed(db, "new", "thought", {}, "new", 2000);
    seed(db, "mid", "thought", {}, "mid", 1500);
    const list = listPages(db);
    expect(list.map((p) => p.slug)).toEqual(["new", "mid", "old"]);
    db.close();
  });

  test("filters by type", () => {
    const db = openDb(":memory:");
    seed(db, "biz/acme", "business", {}, "body");
    seed(db, "trade/k1", "trading", {}, "body");
    seed(db, "biz/contoso", "business", {}, "body");
    const list = listPages(db, { type: "business" });
    expect(list.map((p) => p.slug).sort()).toEqual(["biz/acme", "biz/contoso"]);
    db.close();
  });

  test("filters by slug prefix", () => {
    const db = openDb(":memory:");
    seed(db, "biz/acme", "business", {}, "body");
    seed(db, "biz/contoso", "business", {}, "body");
    seed(db, "trade/k1", "trading", {}, "body");
    const list = listPages(db, { prefix: "biz/" });
    expect(list.map((p) => p.slug).sort()).toEqual(["biz/acme", "biz/contoso"]);
    db.close();
  });

  test("frontmatter_summary surfaces only well-known keys", () => {
    const db = openDb(":memory:");
    seed(db, "p1", "x", { name: "Alice", random: "skip", status: "open", title: "T" }, "body");
    const list = listPages(db);
    const fm = list[0]!.frontmatter_summary;
    expect(fm.name).toBe("Alice");
    expect(fm.status).toBe("open");
    expect(fm.title).toBe("T");
    expect(fm.random).toBeUndefined();
    db.close();
  });

  test("respects limit", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 20; i++) seed(db, `p${i}`, "thought", {}, "body");
    const list = listPages(db, { limit: 5 });
    expect(list.length).toBe(5);
    db.close();
  });
});

describe("searchMemory", () => {
  test("returns empty results when no embeddings present", () => {
    const db = openDb(":memory:");
    const response = searchMemory(db, makeVec(0));
    expect(response.results).toEqual([]);
    expect(response.pending_embeddings).toBe(0);
    db.close();
  });

  test("finds nearest by vector + reports pending count", () => {
    const db = openDb(":memory:");
    seed(db, "near", "thought", {}, "near body");
    seed(db, "far", "thought", {}, "far body");

    const nearVec = makeVec(0);
    const farVec = makeVec(100);

    const blocks = db.prepare("SELECT block_id, page_slug FROM blocks ORDER BY block_id").all() as Array<{
      block_id: number;
      page_slug: string;
    }>;
    const nearBlock = blocks.find((b) => b.page_slug === "near")!;
    const farBlock = blocks.find((b) => b.page_slug === "far")!;
    setEmbedding(db, nearBlock.block_id, nearVec);
    setEmbedding(db, farBlock.block_id, farVec);

    // pending count: 0 because we set embedding_model="test" on both
    const response = searchMemory(db, nearVec, { k: 5 });
    expect(response.pending_embeddings).toBe(0);
    expect(response.results.length).toBe(2);
    expect(response.results[0]!.slug).toBe("near");
    db.close();
  });

  test("type filter narrows results", () => {
    const db = openDb(":memory:");
    seed(db, "biz/acme", "business", {}, "the deal");
    seed(db, "trade/x", "trading", {}, "the deal");

    const blocks = db.prepare("SELECT block_id, page_slug FROM blocks ORDER BY block_id").all() as Array<{
      block_id: number;
      page_slug: string;
    }>;
    for (const b of blocks) {
      setEmbedding(db, b.block_id, makeVec(0));
    }

    const all = searchMemory(db, makeVec(0));
    expect(all.results.length).toBe(2);

    const onlyBiz = searchMemory(db, makeVec(0), { type: "business" });
    expect(onlyBiz.results.length).toBe(1);
    expect(onlyBiz.results[0]!.slug).toBe("biz/acme");
    db.close();
  });

  test("recency boost prefers recent matches when similarity is similar", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    seed(db, "old", "thought", {}, "X content", now - 86400 * 60); // 60 days old
    seed(db, "fresh", "thought", {}, "X content", now);

    const blocks = db.prepare("SELECT block_id, page_slug FROM blocks ORDER BY block_id").all() as Array<{
      block_id: number;
      page_slug: string;
    }>;
    const queryVec = makeVec(0);
    // Both blocks get the SAME embedding so similarity is identical.
    for (const b of blocks) {
      setEmbedding(db, b.block_id, queryVec);
    }

    const response = searchMemory(db, queryVec, {}, now);
    expect(response.results[0]!.slug).toBe("fresh");
    expect(response.results[0]!.score).toBeGreaterThan(response.results[1]!.score);
    db.close();
  });

  test("pending_embeddings counts un-embedded blocks", () => {
    const db = openDb(":memory:");
    seed(db, "embedded", "thought", {}, "yes");
    seed(db, "pending1", "thought", {}, "no");
    seed(db, "pending2", "thought", {}, "no");

    const blocks = db.prepare("SELECT block_id, page_slug FROM blocks").all() as Array<{
      block_id: number;
      page_slug: string;
    }>;
    const embedded = blocks.find((b) => b.page_slug === "embedded")!;
    setEmbedding(db, embedded.block_id, makeVec(0));

    const response = searchMemory(db, makeVec(0));
    expect(response.pending_embeddings).toBe(2);
    expect(response.results.length).toBe(1);
    expect(response.results[0]!.slug).toBe("embedded");
    db.close();
  });

  test("k limits results returned", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) {
      seed(db, `p${i}`, "thought", {}, `body ${i}`);
    }
    const blocks = db.prepare("SELECT block_id FROM blocks").all() as Array<{ block_id: number }>;
    for (const b of blocks) setEmbedding(db, b.block_id, makeVec(0));

    const response = searchMemory(db, makeVec(0), { k: 3 });
    expect(response.results.length).toBe(3);
    db.close();
  });
});
