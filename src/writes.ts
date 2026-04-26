/**
 * Write paths — create_page and append_to_page.
 *
 * Per the design doc, write ordering is locked: disk first (atomic
 * tmpfile + rename), then SQLite transaction (page row + blocks +
 * lineage). On crash mid-write, disk is ahead of index — reindex's
 * body_sha diff repairs the index from disk on next run.
 *
 * Per-slug mutex serializes concurrent writes to the same slug. Different
 * slugs proceed in parallel.
 */
import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import type { Database } from "bun:sqlite";
import { slugToPath, isValidSlug, pagesDir } from "./paths";
import { indexBySlug } from "./indexer";
import { writeLineage, type LineageMeta } from "./lineage";

// Per-slug serialization. Each slug gets its own promise chain.
const slugLocks = new Map<string, Promise<unknown>>();

async function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = slugLocks.get(slug) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  slugLocks.set(
    slug,
    next.finally(() => {
      // Drop the lock entry only if we're still the tail.
      if (slugLocks.get(slug) === next) slugLocks.delete(slug);
    }),
  );
  return next;
}

function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Use a sibling temp file so rename() is on the same filesystem.
  const tmp = path + `.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  // gray-matter.stringify produces frontmatter + body with proper YAML.
  // If frontmatter is empty, skip the --- delimiters entirely.
  const hasFm = frontmatter && Object.keys(frontmatter).length > 0;
  if (!hasFm) return body.endsWith("\n") ? body : body + "\n";
  return matter.stringify(body, frontmatter);
}

// ---------------------------------------------------------------------------
// create_page
// ---------------------------------------------------------------------------

export type CreatePageArgs = {
  slug: string;
  type?: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  lineage: LineageMeta;
};

export type CreatePageResult =
  | { ok: true; slug: string; block_ords: number[] }
  | { ok: false; error: string };

export async function createPage(
  db: Database,
  args: CreatePageArgs,
): Promise<CreatePageResult> {
  if (!isValidSlug(args.slug)) {
    return { ok: false, error: `invalid slug: ${args.slug}` };
  }

  // Reject overwrite of system pages by agents.
  if (args.slug === "zbrain/dream-prompt" && args.lineage.agent_id !== "human") {
    return {
      ok: false,
      error: "zbrain/dream-prompt is human-edit-only in v1; refusing agent write",
    };
  }

  return withSlugLock(args.slug, async () => {
    const path = slugToPath(args.slug);

    // Refuse if slug already exists. append_to_page is the right tool for
    // adding to an existing page.
    const existing = db.prepare("SELECT 1 FROM pages WHERE slug = ?").get(args.slug);
    if (existing || existsSync(path)) {
      return {
        ok: false,
        error: `page already exists: ${args.slug} — use append_to_page instead`,
      };
    }

    // Compose frontmatter with type if provided.
    const fm: Record<string, unknown> = { ...(args.frontmatter ?? {}) };
    if (args.type !== undefined && fm["type"] === undefined) fm["type"] = args.type;

    const rendered = renderMarkdown(fm, args.body);

    // 1) Disk first.
    atomicWrite(path, rendered);

    // 2) SQLite transaction (indexer + lineage row).
    const ts = Math.floor(Date.now() / 1000);
    const block_ords: number[] = [];
    const tx = db.transaction(() => {
      indexBySlug(db, args.slug, ts);
      writeLineage(db, {
        page_slug: args.slug,
        block_ord: -1, // page-level write
        meta: args.lineage,
        ts,
      });
      const blocks = db
        .prepare("SELECT ord FROM blocks WHERE page_slug = ? ORDER BY ord")
        .all(args.slug) as Array<{ ord: number }>;
      for (const b of blocks) block_ords.push(b.ord);
    });
    tx();

    return { ok: true, slug: args.slug, block_ords };
  });
}

// ---------------------------------------------------------------------------
// append_to_page
// ---------------------------------------------------------------------------

export type AppendToPageArgs = {
  slug: string;
  section?: string; // optional H2 heading hint
  content: string;
  lineage: LineageMeta;
};

export type AppendToPageResult =
  | { ok: true; slug: string; block_ord: number }
  | { ok: false; error: string };

/**
 * Append content to an existing page's body. If `section` is provided:
 *   - if the body has a `## <section>` heading, append below it (before the
 *     next heading at <= H2 level, or at end of body if none).
 *   - if missing, create a new `## <section>` heading at end of body and
 *     append below it.
 *
 * Returns the ord of the LAST new block written. (Multi-block content is
 * possible if the appended text contains blank lines or code fences.)
 */
export async function appendToPage(
  db: Database,
  args: AppendToPageArgs,
): Promise<AppendToPageResult> {
  if (!isValidSlug(args.slug)) {
    return { ok: false, error: `invalid slug: ${args.slug}` };
  }
  if (args.slug === "zbrain/dream-prompt" && args.lineage.agent_id !== "human") {
    return {
      ok: false,
      error: "zbrain/dream-prompt is human-edit-only in v1; refusing agent write",
    };
  }

  return withSlugLock(args.slug, async () => {
    const path = slugToPath(args.slug);
    if (!existsSync(path)) {
      return {
        ok: false,
        error: `page does not exist: ${args.slug} — use create_page instead`,
      };
    }

    const raw = readFileSync(path, "utf8");
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;
    const body = parsed.content;

    const newBody = appendInBody(body, args.section, args.content);
    const rendered = renderMarkdown(fm, newBody);

    // 1) Disk first.
    atomicWrite(path, rendered);

    // 2) SQLite transaction.
    const ts = Math.floor(Date.now() / 1000);
    let lastOrd = -1;
    const tx = db.transaction(() => {
      indexBySlug(db, args.slug, ts);
      const blocks = db
        .prepare("SELECT MAX(ord) AS last FROM blocks WHERE page_slug = ?")
        .get(args.slug) as { last: number | null };
      lastOrd = blocks.last ?? -1;
      writeLineage(db, {
        page_slug: args.slug,
        block_ord: lastOrd,
        meta: args.lineage,
        ts,
      });
    });
    tx();

    return { ok: true, slug: args.slug, block_ord: lastOrd };
  });
}

/**
 * Insert `content` into `body` under a `## <section>` heading. If the heading
 * exists, append below it (before the next heading at ≤ H2). If missing,
 * append `## <section>\n\n<content>` at the end of body.
 *
 * Pure function — easy to unit-test.
 */
export function appendInBody(body: string, section: string | undefined, content: string): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) return body;
  const ensureTrailingNewline = (s: string) => (s.endsWith("\n") ? s : s + "\n");

  if (!section) {
    const sep = body.length > 0 && !body.endsWith("\n\n") ? "\n\n" : "";
    return ensureTrailingNewline(body + sep + trimmedContent);
  }

  // MDN-recommended regex meta-character escape.
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s+${escaped}\\s*$`, "m");
  const match = headingRe.exec(body);
  if (!match) {
    // Section missing — create at end.
    const sep = body.length > 0 && !body.endsWith("\n\n") ? "\n\n" : "";
    return ensureTrailingNewline(`${body}${sep}## ${section}\n\n${trimmedContent}`);
  }

  // Section exists. Find the next heading at H1 or H2 after this match.
  const headingStart = match.index;
  const afterHeading = headingStart + match[0].length;
  const tail = body.slice(afterHeading);
  // Match next H1 or H2 (^# or ^##).
  const nextHeadingRe = /^(#{1,2})\s/m;
  const nextMatch = nextHeadingRe.exec(tail);

  let insertAt: number;
  if (nextMatch) {
    insertAt = afterHeading + nextMatch.index;
  } else {
    insertAt = body.length;
  }

  const before = body.slice(0, insertAt).replace(/\s*$/, "");
  const after = body.slice(insertAt);
  const composed = before + "\n\n" + trimmedContent + (after.length > 0 ? "\n\n" + after.trimStart() : "\n");
  return composed;
}
