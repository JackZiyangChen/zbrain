/**
 * Database bootstrap for zbrain.
 *
 * - Resolves a libsqlite3 with extension loading enabled (Homebrew sqlite).
 * - Loads sqlite-vec.
 * - Applies schema.sql (idempotent CREATE IF NOT EXISTS).
 *
 * MUST be called before any Database is opened — Database.setCustomSQLite()
 * is process-global.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateVecPaths } from "../scripts/vec-path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

let customSqliteApplied = false;

/**
 * Locate a libsqlite3 that has SQLITE_OMIT_LOAD_EXTENSION OFF.
 * Bun's bundled sqlite has it ON on every platform, so we always have to
 * point it at a system-provided libsqlite3. Probe order:
 *   1. ZBRAIN_SQLITE_LIB override (any platform).
 *   2. macOS — Homebrew sqlite (`brew --prefix sqlite`/lib/libsqlite3.dylib),
 *      then standard arm64 / Intel-Rosetta fallback paths.
 *   3. Linux — /usr/lib/<arch>-linux-gnu/libsqlite3.so.0 (Debian/Ubuntu glibc),
 *      then /usr/lib/libsqlite3.so / /usr/lib64/libsqlite3.so.0 (RHEL-ish).
 */
export function findSqliteLib(): string {
  const override = process.env.ZBRAIN_SQLITE_LIB;
  if (override && existsSync(override)) return override;

  if (process.platform === "darwin") {
    try {
      const prefix = execSync("brew --prefix sqlite 2>/dev/null", { encoding: "utf8" }).trim();
      if (prefix) {
        const libPath = `${prefix}/lib/libsqlite3.dylib`;
        if (existsSync(libPath)) return libPath;
      }
    } catch {
      // brew not on PATH — try fallback paths
    }
    const macFallbacks = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ];
    for (const p of macFallbacks) {
      if (existsSync(p)) return p;
    }
    throw new Error(
      "Could not locate a libsqlite3 with extension loading enabled.\n" +
      "Run: brew install sqlite\n" +
      "Or set ZBRAIN_SQLITE_LIB to an explicit path.",
    );
  }

  if (process.platform === "linux") {
    const archDir = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
    const linuxCandidates = [
      `/usr/lib/${archDir}/libsqlite3.so.0`,
      `/usr/lib/${archDir}/libsqlite3.so`,
      "/usr/lib/libsqlite3.so.0",
      "/usr/lib/libsqlite3.so",
      "/usr/lib64/libsqlite3.so.0",
      "/usr/lib64/libsqlite3.so",
    ];
    for (const p of linuxCandidates) {
      if (existsSync(p)) return p;
    }
    throw new Error(
      "Could not locate a libsqlite3 with extension loading enabled.\n" +
      "Debian/Ubuntu: apt-get install -y libsqlite3-0 libsqlite3-dev\n" +
      "RHEL/Fedora:  dnf install -y sqlite-libs sqlite-devel\n" +
      "Alpine:        apk add sqlite-libs sqlite-dev (note: musl-built; sqlite-vec prebuilt is glibc — use a glibc base image)\n" +
      "Or set ZBRAIN_SQLITE_LIB to an explicit path.",
    );
  }

  throw new Error(
    `Unsupported platform '${process.platform}'. zbrain v1 supports darwin and linux.\n` +
    "Set ZBRAIN_SQLITE_LIB to an explicit libsqlite3 path to force-resolve.",
  );
}

/**
 * Idempotent: safe to call before opening every DB. Process-global —
 * only takes effect on the FIRST call.
 */
export function ensureCustomSqlite(): string {
  if (customSqliteApplied) return process.env.ZBRAIN_SQLITE_LIB!;
  const path = findSqliteLib();
  Database.setCustomSQLite(path);
  customSqliteApplied = true;
  process.env.ZBRAIN_SQLITE_LIB = path;
  return path;
}

/**
 * Load sqlite-vec extension into an open Database. Throws on failure.
 */
export function loadVecExtension(db: Database): string {
  const candidates = candidateVecPaths();
  const errors: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) {
      errors.push(`  not found: ${path}`);
      continue;
    }
    try {
      (db as any).loadExtension(path);
      return path;
    } catch (e: any) {
      errors.push(`  failed: ${path} -> ${e?.message ?? e}`);
    }
  }
  throw new Error("Could not load sqlite-vec:\n" + errors.join("\n"));
}

/**
 * Apply schema.sql to a database. Idempotent.
 */
export function applySchema(db: Database): void {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

/**
 * Open a zbrain Database at `path` (file or :memory:), with vec extension
 * loaded and schema applied. The hot path for opening — use this everywhere.
 */
export function openDb(path: string): Database {
  ensureCustomSqlite();
  const db = new Database(path);
  loadVecExtension(db);
  applySchema(db);
  return db;
}

/**
 * Read schema_version from the meta table. Returns 0 if unset.
 */
export function schemaVersion(db: Database): number {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  return row ? parseInt(row.value, 10) : 0;
}
