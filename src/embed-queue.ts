/**
 * Embed queue — async background coroutine that embeds blocks marked
 * `embedding_model = 'pending'` and writes them into blocks_vec.
 *
 * Per design doc:
 *   - append_to_page / create_page return immediately after disk + SQLite
 *     write. The block is left with embedding_model='pending'.
 *   - This coroutine drains the queue in batches, calls the embedding API,
 *     writes vec0 rows.
 *   - On server restart, a startup sweep finds any `blocks` rows whose
 *     block_id is NOT in `blocks_vec` and re-enqueues them. (Crash recovery.)
 *   - search_memory excludes pending rows from results AND surfaces the
 *     pending count so the agent can retry after fresh writes.
 */
import type { Database } from "bun:sqlite";
import { embedBatch, currentEmbedModel, EMBEDDING_DIM } from "./embeddings";

const BATCH_SIZE = 32; // OpenAI accepts up to ~2048; 32 keeps latency/throughput balanced.
const POLL_INTERVAL_MS = 500;

export class EmbedQueue {
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(private db: Database) {}

  /**
   * Start the background loop. Idempotent — calling twice is a no-op.
   * Returns immediately; the loop runs until `stop()`.
   */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = this.loop();
  }

  /**
   * Drain everything pending in one pass without entering the loop.
   * Useful for tests and for `zbrain reindex` which wants all writes
   * embedded synchronously before returning.
   */
  async drain(): Promise<{ embedded: number; failed: number }> {
    let embedded = 0;
    let failed = 0;
    while (true) {
      const batch = this.fetchBatch();
      if (batch.length === 0) break;
      const result = await this.processBatch(batch);
      embedded += result.embedded;
      failed += result.failed;
      // If everything in this batch failed, stop to avoid hot-looping.
      if (result.embedded === 0) break;
    }
    return { embedded, failed };
  }

  /**
   * Stop the background loop. Awaits the in-flight pass if any.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /**
   * Crash-recovery sweep. Find blocks rows with no corresponding vec0 row
   * and mark them pending so the queue picks them up.
   */
  startupSweep(): number {
    const result = this.db
      .prepare(
        `UPDATE blocks
            SET embedding_model = 'pending'
          WHERE block_id NOT IN (SELECT rowid FROM blocks_vec)
            AND embedding_model != 'pending'`,
      )
      .run();
    return result.changes;
  }

  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const batch = this.fetchBatch();
        if (batch.length > 0) {
          await this.processBatch(batch);
          continue; // pull next batch immediately
        }
      } catch (e) {
        // Don't let a transient error kill the loop.
        console.error("[embed-queue] loop error:", e);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private fetchBatch(): Array<{ block_id: number; text: string }> {
    return this.db
      .prepare(
        `SELECT block_id, text FROM blocks
          WHERE embedding_model = 'pending'
          ORDER BY block_id ASC
          LIMIT ?`,
      )
      .all(BATCH_SIZE) as Array<{ block_id: number; text: string }>;
  }

  private async processBatch(
    batch: Array<{ block_id: number; text: string }>,
  ): Promise<{ embedded: number; failed: number }> {
    let vectors: Float32Array[];
    try {
      vectors = await embedBatch(batch.map((b) => b.text));
    } catch (e: any) {
      console.error("[embed-queue] embedBatch failed:", e?.message ?? e);
      // Don't mark them failed permanently — leave as pending; next cycle retries.
      // After repeated failures, doctor will surface.
      return { embedded: 0, failed: batch.length };
    }

    if (vectors.length !== batch.length) {
      console.error(
        `[embed-queue] vector count mismatch: ${vectors.length} vs ${batch.length}; skipping batch`,
      );
      return { embedded: 0, failed: batch.length };
    }

    const model = currentEmbedModel();
    let embedded = 0;
    const tx = this.db.transaction(() => {
      const upsertVec = this.db.prepare(
        "INSERT INTO blocks_vec(rowid, embedding) VALUES (?, ?)",
      );
      const deleteVec = this.db.prepare("DELETE FROM blocks_vec WHERE rowid = ?");
      const updateBlock = this.db.prepare(
        "UPDATE blocks SET embedding_model = ? WHERE block_id = ?",
      );
      for (let i = 0; i < batch.length; i++) {
        const { block_id } = batch[i]!;
        const vec = vectors[i]!;
        if (vec.length !== EMBEDDING_DIM) {
          console.error(
            `[embed-queue] dim mismatch for block ${block_id}: ${vec.length}`,
          );
          continue;
        }
        // Replace any stale vec0 row (e.g., a previous embedding for this block).
        deleteVec.run(block_id);
        upsertVec.run(block_id, new Uint8Array(vec.buffer));
        updateBlock.run(model, block_id);
        embedded++;
      }
    });
    tx();
    return { embedded, failed: batch.length - embedded };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
