/**
 * Dream — nightly consolidation pipeline.
 *
 * Reads:
 *   - lineage rows from the last 24h (always)
 *   - the page bodies that were touched (joined from lineage → pages)
 *   - yesterday's dream summary, if present (high-priority context)
 *   - (optional) OpenClaw orchestrator log, if --openclaw-log path provided
 *
 * Calls:
 *   - LLM with the prompt at pages/zbrain/dream-prompt.md as system message
 *   - Token budget enforced at ~80k via gpt-tokenizer (soft cap, provider-
 *     agnostic). Truncation priority: prev dream → lineage → page bodies
 *     by lineage-write density desc.
 *
 * Writes:
 *   - pages/dream/YYYY-MM-DD.md  (the consolidated narrative)
 *   - .zbrain/dream-proposals/YYYY-MM-DD.json  (PROPOSE: lines parsed)
 *   - one lineage row attributing the dream page write to agent_id="dream"
 *
 * NEVER auto-applies proposals. `zbrain dream-review` triages them.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encode } from "gpt-tokenizer";
import type { Database } from "bun:sqlite";
import { dataDir, dreamProposalsDir, pagesDir, slugToPath } from "./paths";
import { createPage } from "./writes";
import { sentinelLineage } from "./lineage";
import { callLlm } from "./llm";

const TOKEN_BUDGET = 80_000;

export type DreamLineageRow = {
  page_slug: string;
  block_ord: number;
  agent_id: string;
  parent_agent_id: string;
  spawn_chain_json: string;
  tool_call_id: string;
  ts: number;
};

export type DreamProposal = {
  slug: string;
  reason: string;
  content: string;
  idx: number;
  status: "pending" | "accepted" | "rejected" | "skipped";
};

export type DreamResult = {
  date: string; // YYYY-MM-DD
  dream_slug: string;
  proposals_path: string;
  proposals: DreamProposal[];
  truncated: boolean;
  input_tokens: number;
  output_tokens: number;
};

export type DreamArgs = {
  /** Override the date the dream covers (default: today, UTC). Format YYYY-MM-DD. */
  date?: string;
  /** Override the cutoff "now" timestamp for the 24h window (Unix epoch s). */
  now?: number;
  /** Optional path to an OpenClaw session log (newline-delimited JSON). */
  openclawLog?: string;
};

function todayISO(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

function tokenLen(text: string): number {
  // gpt-tokenizer is the soft-cap counter regardless of LLM provider.
  return encode(text).length;
}

function fetchLineage(db: Database, sinceTs: number): DreamLineageRow[] {
  return db
    .prepare(
      `SELECT page_slug, block_ord, agent_id, parent_agent_id,
              spawn_chain_json, tool_call_id, ts
         FROM lineage
        WHERE ts >= ?
        ORDER BY ts ASC`,
    )
    .all(sinceTs) as DreamLineageRow[];
}

function readPageBody(slug: string): string | null {
  const path = slugToPath(slug);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function readPrevDream(yesterday: string): string | null {
  const path = slugToPath(`dream/${yesterday}`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function readOpenclawLog(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the user message for the LLM. Truncation respects TOKEN_BUDGET
 * with priority: prev dream → lineage → page bodies by write density desc.
 *
 * Returns the assembled prompt and a `truncated` flag.
 */
function buildPrompt(args: {
  date: string;
  prevDream: string | null;
  lineage: DreamLineageRow[];
  pageBodies: Array<{ slug: string; body: string; writeCount: number }>;
  openclawLog: string | null;
}): { userMessage: string; truncated: boolean } {
  const sections: string[] = [];
  let used = 0;
  let truncated = false;

  const tryAdd = (label: string, content: string): boolean => {
    const block = `\n\n--- ${label} ---\n${content}`;
    const cost = tokenLen(block);
    if (used + cost > TOKEN_BUDGET) {
      truncated = true;
      return false;
    }
    sections.push(block);
    used += cost;
    return true;
  };

  // Header (always included; tiny).
  const header = `Date: ${args.date}\nLineage rows: ${args.lineage.length}\nPages touched: ${args.pageBodies.length}`;
  sections.push(header);
  used += tokenLen(header);

  // Priority 1: previous dream (if any)
  if (args.prevDream) tryAdd("Yesterday's dream", args.prevDream);

  // Priority 2: lineage rows (compact)
  if (args.lineage.length > 0) {
    const lineageText = args.lineage
      .map(
        (r) =>
          `${new Date(r.ts * 1000).toISOString()} ${r.agent_id} → ${r.page_slug}#${r.block_ord} (parent: ${r.parent_agent_id}, tool_call: ${r.tool_call_id})`,
      )
      .join("\n");
    tryAdd("Lineage (today)", lineageText);
  }

  // Priority 3: openclaw log (if provided and fits)
  if (args.openclawLog) tryAdd("OpenClaw session log", args.openclawLog);

  // Priority 4: page bodies sorted by write density desc, until budget
  // exhausted.
  const sortedPages = [...args.pageBodies].sort(
    (a, b) => b.writeCount - a.writeCount,
  );
  for (const p of sortedPages) {
    const ok = tryAdd(`Page: ${p.slug} (writes: ${p.writeCount})`, p.body);
    if (!ok) break;
  }

  if (truncated) {
    sections.push(
      `\n\n[NOTE] Input exceeded ~${TOKEN_BUDGET} token budget; lower-density pages excluded.`,
    );
  }

  return { userMessage: sections.join(""), truncated };
}

/**
 * Extract PROPOSE: lines from the LLM output. Header line shape:
 *   PROPOSE: append to <slug> — <reason> — <inline content...>
 * Trailing lines (until the next PROPOSE: header or end-of-text) are
 * appended to the content. Headers without the full slug/reason/content
 * triple are silently skipped.
 */
export function parseProposals(text: string): Array<Omit<DreamProposal, "status">> {
  const headerRe = /^PROPOSE:\s+append to\s+(\S+)\s+—\s+(.+)$/gm;
  type Header = {
    slug: string;
    reason: string;
    inlineContent: string;
    headerStart: number;
    bodyStart: number;
  };
  const headers: Header[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    const rest = m[2]!;
    const sepIdx = rest.indexOf(" — ");
    if (sepIdx === -1) continue; // malformed — skip
    const reason = rest.slice(0, sepIdx).trim();
    const inlineContent = rest.slice(sepIdx + 3).trim();
    headers.push({
      slug: m[1]!,
      reason,
      inlineContent,
      headerStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  const proposals: Array<Omit<DreamProposal, "status">> = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const end = i + 1 < headers.length ? headers[i + 1]!.headerStart : text.length;
    const trailing = text.slice(h.bodyStart, end).trim();
    const content = trailing.length > 0
      ? (h.inlineContent.length > 0 ? `${h.inlineContent}\n${trailing}` : trailing)
      : h.inlineContent;
    proposals.push({
      slug: h.slug,
      reason: h.reason,
      content,
      idx: proposals.length,
    });
  }
  return proposals;
}

/**
 * Run the dream pipeline once. The high-level steps map to the design doc.
 */
export async function runDream(db: Database, args: DreamArgs = {}): Promise<DreamResult> {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const date = args.date ?? todayISO(now);
  const sinceTs = now - 24 * 3600;

  // Yesterday in YYYY-MM-DD UTC.
  const yesterdayDate = todayISO(now - 24 * 3600);

  // Step 1: gather inputs
  const lineage = fetchLineage(db, sinceTs);
  const pageWriteCounts = new Map<string, number>();
  for (const r of lineage) {
    pageWriteCounts.set(r.page_slug, (pageWriteCounts.get(r.page_slug) ?? 0) + 1);
  }
  const pageBodies: Array<{ slug: string; body: string; writeCount: number }> = [];
  for (const [slug, writeCount] of pageWriteCounts) {
    const body = readPageBody(slug);
    if (body !== null) pageBodies.push({ slug, body, writeCount });
  }
  const prevDream = readPrevDream(yesterdayDate);
  const openclawLog = readOpenclawLog(args.openclawLog);

  // Step 2: read system prompt
  const promptPath = slugToPath("zbrain/dream-prompt");
  if (!existsSync(promptPath)) {
    throw new Error(
      `dream prompt missing: ${promptPath}. Run \`zbrain init\` to seed it.`,
    );
  }
  const systemPrompt = readFileSync(promptPath, "utf8");

  // Step 3: assemble user message + check budget
  const { userMessage, truncated } = buildPrompt({
    date,
    prevDream,
    lineage,
    pageBodies,
    openclawLog,
  });

  // Step 4: call LLM
  const llmResult = await callLlm({ systemPrompt, userMessage, maxTokens: 4000 });

  // Step 5: parse PROPOSE: lines
  const parsedProposals = parseProposals(llmResult.text);
  const proposals: DreamProposal[] = parsedProposals.map((p) => ({
    ...p,
    status: "pending",
  }));

  // Step 6: write proposals.json
  if (!existsSync(dreamProposalsDir())) {
    mkdirSync(dreamProposalsDir(), { recursive: true });
  }
  const proposalsPath = join(dreamProposalsDir(), `${date}.json`);
  writeFileSync(proposalsPath, JSON.stringify(proposals, null, 2));

  // Step 7: strip PROPOSE: lines from the body before saving the dream page.
  const dreamBody = stripProposeLines(llmResult.text).trim();

  // Step 8: write the dream page via createPage so lineage is captured.
  const dreamSlug = `dream/${date}`;
  // Avoid clobbering an existing dream for the same date — let the user
  // decide whether to overwrite via CLI flag (v1: just append a "-2" suffix).
  let finalSlug = dreamSlug;
  let suffix = 1;
  while (existsSync(slugToPath(finalSlug))) {
    suffix += 1;
    finalSlug = `${dreamSlug}-${suffix}`;
  }
  const result = await createPage(db, {
    slug: finalSlug,
    type: "dream",
    frontmatter: {
      date,
      llm_model: llmResult.model,
      truncated,
      input_tokens: llmResult.usage?.input_tokens,
      output_tokens: llmResult.usage?.output_tokens,
      proposals_count: proposals.length,
    },
    body: dreamBody,
    lineage: sentinelLineage({
      agent_id: "dream",
      tool_call_id: `dream:${date}`,
    }),
  });
  if (!result.ok) {
    throw new Error(`dream createPage failed: ${result.error}`);
  }

  return {
    date,
    dream_slug: finalSlug,
    proposals_path: proposalsPath,
    proposals,
    truncated,
    input_tokens: llmResult.usage?.input_tokens ?? 0,
    output_tokens: llmResult.usage?.output_tokens ?? 0,
  };
}

function stripProposeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^PROPOSE:\s+append to\s+/.test(line))
    .join("\n");
}

/**
 * Apply an accepted proposal — used by `zbrain dream-review` CLI when the
 * user accepts a proposal. Calls append_to_page with dream-review lineage.
 */
export async function applyProposal(
  db: Database,
  date: string,
  proposal: DreamProposal,
): Promise<{ ok: true; block_ord: number } | { ok: false; error: string }> {
  const { appendToPage } = await import("./writes");
  return appendToPage(db, {
    slug: proposal.slug,
    section: undefined,
    content: proposal.content,
    lineage: sentinelLineage({
      agent_id: "dream-review",
      tool_call_id: `dream-review:${date}:${proposal.idx}`,
      parent_agent_id: "dream",
      spawn_chain: ["dream", "dream-review"],
    }),
  });
}

export function loadProposals(date: string): DreamProposal[] {
  const path = join(dreamProposalsDir(), `${date}.json`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

export function saveProposals(date: string, proposals: DreamProposal[]): void {
  if (!existsSync(dreamProposalsDir())) {
    mkdirSync(dreamProposalsDir(), { recursive: true });
  }
  const path = join(dreamProposalsDir(), `${date}.json`);
  writeFileSync(path, JSON.stringify(proposals, null, 2));
}
