/**
 * Indexer — parse markdown files under pages/ and upsert into SQLite.
 *
 * Two entry points:
 * - `indexFile(db, slug, path)` — index a single file (called from MCP write
 *    paths AFTER the disk write commits).
 * - `reindexAll(db)` — walk pages/ and reconcile with the index. Used by
 *    `zbrain reindex` CLI and on first server start.
 *
 * Reindex semantics (from design doc):
 *   1. SHA-256 of body — skip unchanged.
 *   2. Edited file → block-level diff, mark embedding_model='pending' for
 *      changed blocks.
 *   3. New file → insert page + blocks.
 *   4. Deleted file → orphan cleanup (page row with no file).
 *   5. Manual edits get one lineage row: agent_id="human",
 *      tool_call_id="reindex:<ts>".
 */
import { Database } from "bun:sqlite";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { chunkBody } from "./chunking";
import { pagesDir, pathToSlug, slugToPath, isValidSlug } from "./paths";

export type ParsedPage = {
  slug: string;
  type: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  bodySha: string;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseFile(slug: string, fullPath: string): ParsedPage {
  const raw = readFileSync(fullPath, "utf8");
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const type = typeof fm["type"] === "string" ? (fm["type"] as string) : null;
  const body = parsed.content;
  return {
    slug,
    type,
    frontmatter: fm,
    body,
    bodySha: sha256(body),
  };
}

/**
 * Upsert a single page + its blocks into the index. Caller decides whether
 * to write a lineage row (this function does NOT — callers handle lineage
 * because reindex/MCP-write/watcher each have different lineage shapes).
 *
 * Idempotent: if the body_sha matches what's already stored, no-op.
 *
 * Returns:
 *   - `unchanged` when body_sha matched
 *   - `inserted` when the page row was newly created
 *   - `updated`  when the page existed but changed
 */
export function indexParsed(
  db: Database,
  parsed: ParsedPage,
  now: number = Math.floor(Date.now() / 1000),
): "unchanged" | "inserted" | "updated" {
  const existing = db
    .prepare("SELECT body_sha FROM pages WHERE slug = ?")
    .get(parsed.slug) as { body_sha: string | null } | null;

  if (existing && existing.body_sha === parsed.bodySha) {
    // Body unchanged. Frontmatter MAY have changed but for v1 we only diff body.
    return "unchanged";
  }

  const isInsert = !existing;
  const fmJson = JSON.stringify(parsed.frontmatter ?? {});

  // Transaction: page upsert + blocks reconciliation.
  const tx = db.transaction(() => {
    if (isInsert) {
      db.prepare(
        `INSERT INTO pages(slug, type, frontmatter_json, body, body_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.slug,
        parsed.type,
        fmJson,
        parsed.body,
        parsed.bodySha,
        now,
      );
    } else {
      db.prepare(
        `UPDATE pages
            SET type = ?, frontmatter_json = ?, body = ?, body_sha = ?, updated_at = ?
          WHERE slug = ?`,
      ).run(
        parsed.type,
        fmJson,
        parsed.body,
        parsed.bodySha,
        now,
        parsed.slug,
      );
    }

    // Block reconciliation. v1 simple strategy: re-chunk and replace.
    // We delete all existing blocks_vec rows for the page first (vec0
    // doesn't cascade), then delete blocks rows (cascade-safe via FK).
    const oldBlocks = db
      .prepare(
        "SELECT block_id FROM blocks WHERE page_slug = ? ORDER BY ord",
      )
      .all(parsed.slug) as Array<{ block_id: number }>;
    for (const b of oldBlocks) {
      db.prepare("DELETE FROM blocks_vec WHERE rowid = ?").run(b.block_id);
    }
    db.prepare("DELETE FROM blocks WHERE page_slug = ?").run(parsed.slug);

    const newChunks = chunkBody(parsed.body);
    const insertBlock = db.prepare(
      `INSERT INTO blocks(page_slug, ord, text, text_sha, embedding_model, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    for (let i = 0; i < newChunks.length; i++) {
      const text = newChunks[i]!;
      insertBlock.run(parsed.slug, i, text, sha256(text), now);
    }
  });

  tx();
  return isInsert ? "inserted" : "updated";
}

/**
 * Walk pages/ and return absolute paths of every .md file.
 * Excludes hidden directories (starting with `.`).
 */
async function walkPages(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(full);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }

  await visit(root);
  return out;
}

export type ReindexReport = {
  scanned: number;
  inserted: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
};

/**
 * Walk pages/, parse every .md, reconcile against the index. Removes orphan
 * page rows whose files no longer exist.
 *
 * Caller writes lineage rows for inserted/updated/deleted pages
 * (sentinel `agent_id: "human", tool_call_id: "reindex:<ts>"`).
 */
export async function reindexAll(db: Database): Promise<ReindexReport> {
  const root = pagesDir();
  if (!existsSync(root)) {
    return { scanned: 0, inserted: [], updated: [], unchanged: [], deleted: [] };
  }

  const now = Math.floor(Date.now() / 1000);
  const files = await walkPages(root);
  const report: ReindexReport = {
    scanned: files.length,
    inserted: [],
    updated: [],
    unchanged: [],
    deleted: [],
  };

  const seenSlugs = new Set<string>();

  for (const path of files) {
    const slug = pathToSlug(path);
    if (!slug || !isValidSlug(slug)) continue;
    seenSlugs.add(slug);
    const parsed = parseFile(slug, path);
    const result = indexParsed(db, parsed, now);
    if (result === "inserted") report.inserted.push(slug);
    else if (result === "updated") report.updated.push(slug);
    else report.unchanged.push(slug);
  }

  // Orphan cleanup: any pages row whose file is gone.
  const allPageSlugs = db
    .prepare("SELECT slug FROM pages")
    .all() as Array<{ slug: string }>;
  for (const { slug } of allPageSlugs) {
    if (!seenSlugs.has(slug)) {
      // File missing — delete page (cascades to blocks via FK).
      const blocks = db
        .prepare("SELECT block_id FROM blocks WHERE page_slug = ?")
        .all(slug) as Array<{ block_id: number }>;
      const tx = db.transaction(() => {
        for (const b of blocks) {
          db.prepare("DELETE FROM blocks_vec WHERE rowid = ?").run(b.block_id);
        }
        db.prepare("DELETE FROM pages WHERE slug = ?").run(slug);
      });
      tx();
      report.deleted.push(slug);
    }
  }

  return report;
}

/**
 * Index a single file by slug. Returns the upsert result.
 * Used by MCP write paths AFTER the disk write commits.
 */
export function indexBySlug(
  db: Database,
  slug: string,
  now: number = Math.floor(Date.now() / 1000),
): "unchanged" | "inserted" | "updated" | "missing" {
  const path = slugToPath(slug);
  if (!existsSync(path)) return "missing";
  const parsed = parseFile(slug, path);
  return indexParsed(db, parsed, now);
}
