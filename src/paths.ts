/**
 * Filesystem path resolution for zbrain.
 *
 * Default ZBRAIN_HOME is the repo root. Override via env var for deployments.
 */
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  // src/paths.ts → src/ → zbrain/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function zbrainHome(): string {
  return process.env.ZBRAIN_HOME ?? repoRoot();
}

export function pagesDir(): string {
  return join(zbrainHome(), "pages");
}

export function dataDir(): string {
  return join(zbrainHome(), ".zbrain");
}

export function indexDbPath(): string {
  return join(dataDir(), "index.db");
}

export function dreamProposalsDir(): string {
  return join(dataDir(), "dream-proposals");
}

/**
 * Map a slug like "business/acme/q3-expansion" to its on-disk path.
 * Slugs use forward slashes; on disk they map to nested directories with
 * a `.md` suffix at the leaf.
 */
export function slugToPath(slug: string): string {
  return join(pagesDir(), slug + ".md");
}

/**
 * Inverse: map an on-disk path under pages/ back to a slug.
 * Returns null if the path is not under pages/ or not a .md file.
 */
export function pathToSlug(path: string): string | null {
  const abs = resolve(path);
  const rel = relative(pagesDir(), abs);
  if (rel.startsWith("..") || rel === "") return null;
  if (!rel.endsWith(".md")) return null;
  return rel.slice(0, -3); // strip .md
}

/**
 * Validate a slug: forward-slash separators, no .. traversal, no leading
 * slash, no whitespace, alphanumerics + hyphens + underscores + slashes only.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > 256) return false;
  if (slug.startsWith("/") || slug.endsWith("/")) return false;
  if (slug.includes("..")) return false;
  if (slug.includes("//")) return false;
  return /^[a-zA-Z0-9_\-./]+$/.test(slug);
}
