import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { indexParsed, sha256 } from "../src/indexer";
import { EmbedQueue } from "../src/embed-queue";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `zbrain-eq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });
  mkdirSync(join(tmpHome, ".zbrain"), { recursive: true });
  process.env.ZBRAIN_HOME = tmpHome;
  process.env.ZBRAIN_EMBED_PROVIDER = "fake";
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ZBRAIN_HOME;
  delete process.env.ZBRAIN_EMBED_PROVIDER;
});

describe("EmbedQueue.drain", () => {
  test("embeds pending blocks and writes blocks_vec rows", async () => {
    const db = openDb(":memory:");
    indexParsed(db, {
      slug: "p1",
      type: null,
      frontmatter: {},
      body: "First paragraph.\n\nSecond paragraph.",
      bodySha: sha256("First paragraph.\n\nSecond paragraph."),
    });

    const before = db
      .prepare("SELECT COUNT(*) AS c FROM blocks WHERE embedding_model = 'pending'")
      .get() as { c: number };
    expect(before.c).toBe(2);

    const queue = new EmbedQueue(db);
    const result = await queue.drain();
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);

    const stillPending = db
      .prepare("SELECT COUNT(*) AS c FROM blocks WHERE embedding_model = 'pending'")
      .get() as { c: number };
    expect(stillPending.c).toBe(0);

    const vecCount = db.prepare("SELECT COUNT(*) AS c FROM blocks_vec").get() as { c: number };
    expect(vecCount.c).toBe(2);

    db.close();
  });

  test("drain with no pending is a clean no-op", async () => {
    const db = openDb(":memory:");
    const queue = new EmbedQueue(db);
    const result = await queue.drain();
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(0);
    db.close();
  });

  test("re-running drain is idempotent (no double-insert)", async () => {
    const db = openDb(":memory:");
    indexParsed(db, {
      slug: "p",
      type: null,
      frontmatter: {},
      body: "stable",
      bodySha: sha256("stable"),
    });
    const queue = new EmbedQueue(db);
    await queue.drain();
    await queue.drain(); // second pass: no pending, no-op
    const vecCount = db.prepare("SELECT COUNT(*) AS c FROM blocks_vec").get() as { c: number };
    expect(vecCount.c).toBe(1);
    db.close();
  });
});

describe("EmbedQueue.startupSweep", () => {
  test("re-enqueues blocks missing from blocks_vec (crash recovery)", async () => {
    const db = openDb(":memory:");
    indexParsed(db, {
      slug: "p",
      type: null,
      frontmatter: {},
      body: "one\n\ntwo",
      bodySha: sha256("one\n\ntwo"),
    });

    // Pretend the embed-queue ran and embedded both, then "crashed"
    // mid-write: vec row missing for block 1.
    const queue = new EmbedQueue(db);
    await queue.drain();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM blocks_vec").get() as any).c,
    ).toBe(2);

    // Simulate corruption: delete one vec row but leave embedding_model='fake'.
    db.prepare("DELETE FROM blocks_vec WHERE rowid = (SELECT MIN(block_id) FROM blocks)").run();

    // Sweep should mark the orphan block as pending.
    const swept = queue.startupSweep();
    expect(swept).toBe(1);

    // And drain should re-embed it.
    const result = await queue.drain();
    expect(result.embedded).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM blocks_vec").get() as any).c,
    ).toBe(2);

    db.close();
  });

  test("sweep on a healthy index is a no-op", () => {
    const db = openDb(":memory:");
    const queue = new EmbedQueue(db);
    expect(queue.startupSweep()).toBe(0);
    db.close();
  });
});
