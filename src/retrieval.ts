/**
 * Retrieval — implements get_page, list_pages, and search_memory.
 *
 * Per the design doc:
 * - Page-addressed retrieval is primary. get_page is the fast path.
 * - Semantic search is fallback. Combines vec0 distance with recency
 *   boost: score = (1 - cosine_distance) * 0.7 + recency_factor * 0.3
 *   where recency_factor = exp(-age_days / 14).
 * - search_memory returns { results, pending_embeddings } so the agent
 *   knows when to retry after a fresh write.
 */
import type { Database } from "bun:sqlite";

export type PageResult = {
  slug: string;
  type: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  links_outbound: string[]; // empty in v1; wiki-link parsing deferred to v2
  updated_at: number;
};

export function getPage(db: Database, slug: string): PageResult | null {
  const row = db
    .prepare(
      `SELECT slug, type, frontmatter_json, body, updated_at
         FROM pages WHERE slug = ?`,
    )
    .get(slug) as {
    slug: string;
    type: string | null;
    frontmatter_json: string;
    body: string;
    updated_at: number;
  } | null;

  if (!row) return null;

  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = JSON.parse(row.frontmatter_json);
  } catch {
    // malformed JSON in storage; surface empty frontmatter rather than throw
  }

  return {
    slug: row.slug,
    type: row.type,
    frontmatter,
    body: row.body,
    links_outbound: [], // v2: wiki-link parsing
    updated_at: row.updated_at,
  };
}

export type ListPageEntry = {
  slug: string;
  type: string | null;
  frontmatter_summary: Record<string, unknown>;
  updated_at: number;
};

const FRONTMATTER_SUMMARY_KEYS = ["name", "status", "title"];

export type ListOptions = {
  type?: string;
  prefix?: string;
  limit?: number;
};

export function listPages(db: Database, opts: ListOptions = {}): ListPageEntry[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.type !== undefined) {
    where.push("type = ?");
    params.push(opts.type);
  }
  if (opts.prefix !== undefined) {
    where.push("slug LIKE ?");
    params.push(opts.prefix + "%");
  }
  const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const rows = db
    .prepare(
      `SELECT slug, type, frontmatter_json, updated_at
         FROM pages ${whereClause}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    slug: string;
    type: string | null;
    frontmatter_json: string;
    updated_at: number;
  }>;

  return rows.map((r) => {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.frontmatter_json);
    } catch {
      // ignore
    }
    const summary: Record<string, unknown> = {};
    for (const k of FRONTMATTER_SUMMARY_KEYS) {
      if (k in fm) summary[k] = fm[k];
    }
    return {
      slug: r.slug,
      type: r.type,
      frontmatter_summary: summary,
      updated_at: r.updated_at,
    };
  });
}

export type SearchHit = {
  slug: string;
  block_text: string;
  score: number;
  ord: number;
  updated_at: number;
};

export type SearchOptions = {
  type?: string;
  k?: number;
};

export type SearchResponse = {
  results: SearchHit[];
  pending_embeddings: number;
};

const RECENCY_HALFLIFE_DAYS = 14;

function recencyFactor(updatedAt: number, now: number): number {
  const ageSeconds = Math.max(0, now - updatedAt);
  const ageDays = ageSeconds / 86400;
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Search memory. Embedding is provided by the caller (server.ts) — this
 * function is pure DB. Score = (1 - cosine_distance) * 0.7 + recency * 0.3.
 *
 * pending_embeddings = count of blocks with embedding_model='pending', so
 * the calling agent knows whether to retry after a recent write.
 */
export function searchMemory(
  db: Database,
  queryEmbedding: Float32Array,
  opts: SearchOptions = {},
  now: number = Math.floor(Date.now() / 1000),
): SearchResponse {
  const k = Math.min(Math.max(opts.k ?? 5, 1), 50);

  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM blocks WHERE embedding_model = 'pending'")
    .get() as { c: number };

  // Over-fetch a few candidates so type filtering doesn't starve.
  // sqlite-vec requires the LIMIT to live ON the vec0 scan itself, not after
  // a JOIN — use a CTE so the KNN runs first then we join metadata.
  const overK = k * 4;
  const candidateRows = db
    .prepare(
      `WITH knn AS (
         SELECT rowid AS block_id, distance
           FROM blocks_vec
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
       )
       SELECT knn.block_id  AS block_id,
              knn.distance  AS distance,
              b.page_slug   AS slug,
              b.text        AS text,
              b.ord         AS ord,
              p.type        AS type,
              p.updated_at  AS updated_at
         FROM knn
         JOIN blocks b ON b.block_id  = knn.block_id
         JOIN pages  p ON p.slug      = b.page_slug
        ORDER BY knn.distance`,
    )
    .all(new Uint8Array(queryEmbedding.buffer), overK) as Array<{
    block_id: number;
    distance: number;
    slug: string;
    text: string;
    ord: number;
    type: string | null;
    updated_at: number;
  }>;

  const filtered =
    opts.type === undefined
      ? candidateRows
      : candidateRows.filter((r) => r.type === opts.type);

  const scored = filtered.map((r) => {
    const sim = 1 - r.distance;
    const rec = recencyFactor(r.updated_at, now);
    const score = sim * 0.7 + rec * 0.3;
    return {
      slug: r.slug,
      block_text: r.text,
      score,
      ord: r.ord,
      updated_at: r.updated_at,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    results: scored.slice(0, k),
    pending_embeddings: pending.c,
  };
}
