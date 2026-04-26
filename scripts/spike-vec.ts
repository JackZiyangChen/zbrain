/**
 * Day 0 Spike A — sqlite-vec extension load test (bun:sqlite + Homebrew sqlite).
 *
 * Bun's bundled sqlite has SQLITE_OMIT_LOAD_EXTENSION enabled (security default).
 * macOS system sqlite also has it disabled. The fix: point bun:sqlite at a
 * Homebrew-installed libsqlite3 via Database.setCustomSQLite().
 *
 * Prerequisite: `brew install sqlite` (one-time setup).
 *
 * Goal: prove sqlite-vec loads, vec0 virtual table works, KNN returns the
 * closest match. If this passes, sqlite-vec is the v1 vector backend.
 *
 * Run: bun run scripts/spike-vec.ts
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { candidateVecPaths } from "./vec-path";

const DIM = 1536;

function findHomebrewSqlite(): string {
  // 1) Explicit override
  const override = process.env.ZBRAIN_SQLITE_LIB;
  if (override && existsSync(override)) return override;

  // 2) Ask Homebrew
  try {
    const prefix = execSync("brew --prefix sqlite 2>/dev/null", { encoding: "utf8" }).trim();
    if (prefix) {
      const libPath = `${prefix}/lib/libsqlite3.dylib`;
      if (existsSync(libPath)) return libPath;
    }
  } catch {
    // brew not available
  }

  // 3) Common known locations
  const candidates = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",    // Intel / Rosetta Homebrew
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  throw new Error(
    "Could not locate a libsqlite3 with extension loading enabled.\n" +
    "Run: brew install sqlite\n" +
    "Or set ZBRAIN_SQLITE_LIB to an explicit path.",
  );
}

function tryLoadVec(db: Database): string {
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
  throw new Error("Could not load sqlite-vec from any known path:\n" + errors.join("\n"));
}

async function main() {
  console.log("=== Spike A: sqlite-vec on bun:sqlite (Homebrew sqlite) ===");
  console.log(`Bun ${Bun.version}, platform: ${process.platform}/${process.arch}`);

  // Step 1: locate Homebrew sqlite
  let brewSqlite: string;
  try {
    brewSqlite = findHomebrewSqlite();
    console.log(`✓ Homebrew sqlite found: ${brewSqlite}`);
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  // Step 2: override Bun's bundled sqlite
  Database.setCustomSQLite(brewSqlite);
  console.log(`✓ Database.setCustomSQLite() called`);

  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL;");
  console.log(`✓ in-memory database opened, WAL enabled`);

  // Step 3: load sqlite-vec
  let vecPath: string;
  try {
    vecPath = tryLoadVec(db);
    console.log(`✓ sqlite-vec loaded: ${vecPath}`);
  } catch (e: any) {
    console.error(`✗ FAILED: ${e.message}`);
    console.error("\nDecision: activate Plan B (FTS5 keyword search) for v1.");
    process.exit(1);
  }

  // Step 4: confirm extension is functional
  const versionRow = db.prepare("SELECT vec_version() AS v").get() as { v: string };
  console.log(`✓ vec_version() = ${versionRow.v}`);

  // Step 5: create a vec0 virtual table
  db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${DIM}])`);
  console.log(`✓ vec0 virtual table created (dim=${DIM})`);

  // Step 6: insert two synthetic vectors
  const vec1 = new Float32Array(DIM).fill(0.1);
  const vec2 = new Float32Array(DIM).fill(0.9);
  for (let i = 0; i < 10; i++) vec1[i] = 0.5;
  for (let i = 0; i < 10; i++) vec2[i] = -0.5;

  const ins = db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)");
  ins.run(1, new Uint8Array(vec1.buffer));
  ins.run(2, new Uint8Array(vec2.buffer));
  console.log(`✓ inserted 2 vectors`);

  // Step 7: KNN query — expect rowid=1 to be closest to a near-copy of vec1
  const query = new Float32Array(DIM).fill(0.1);
  for (let i = 0; i < 10; i++) query[i] = 0.5;
  const results = db
    .prepare(
      "SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 2",
    )
    .all(new Uint8Array(query.buffer)) as Array<{ rowid: number; distance: number }>;

  console.log(`✓ KNN query returned ${results.length} rows:`);
  for (const r of results) {
    console.log(`    rowid=${r.rowid}  distance=${r.distance.toFixed(6)}`);
  }

  if (results[0]?.rowid !== 1) {
    console.error(`✗ expected rowid=1 closest, got rowid=${results[0]?.rowid}`);
    process.exit(1);
  }
  console.log(`✓ closest match is rowid=1 (as expected)`);

  db.close();
  console.log("\n=== Spike A PASSED ===");
  console.log(`Vector backend viable. Proceed with sqlite-vec + bun:sqlite for v1.`);
  console.log(`Production setup must call Database.setCustomSQLite("${brewSqlite}") before opening the DB.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
