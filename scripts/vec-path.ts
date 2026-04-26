import { platform } from "node:os";
import { join } from "node:path";

/**
 * Resolves the on-disk path to the sqlite-vec extension binary.
 * Platform-aware: dylib (macOS), so (linux), dll (windows).
 * Override via ZBRAIN_VEC_PATH env var for unusual setups.
 */
export function resolveVecPath(): string {
  const override = process.env.ZBRAIN_VEC_PATH;
  if (override) return override;

  const ext =
    platform() === "darwin" ? "dylib" :
    platform() === "win32"  ? "dll"   :
    "so";

  // sqlite-vec npm package layout: node_modules/sqlite-vec-<arch>/vec0.<ext>
  // Try several known locations in order.
  const candidates = [
    join(process.cwd(), "node_modules", "sqlite-vec", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-darwin-arm64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-darwin-x64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-linux-x64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-linux-arm64", `vec0.${ext}`),
  ];

  return candidates[0]!; // first as default; spike-vec tries them all
}

export function candidateVecPaths(): string[] {
  const override = process.env.ZBRAIN_VEC_PATH;
  if (override) return [override];

  const ext =
    platform() === "darwin" ? "dylib" :
    platform() === "win32"  ? "dll"   :
    "so";

  return [
    join(process.cwd(), "node_modules", "sqlite-vec", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-darwin-arm64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-darwin-x64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-linux-x64", `vec0.${ext}`),
    join(process.cwd(), "node_modules", "sqlite-vec-linux-arm64", `vec0.${ext}`),
  ];
}
