/**
 * zbrain MCP server.
 *
 * Day 2: read-side tools (get_page, list_pages, search_memory).
 * Day 3 will add write-side tools (create_page, append_to_page) with
 * server-enforced lineage validation, plus trace_lineage.
 *
 * Transport: stdio (default for MCP). Run via `bun run src/server.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import { dataDir, indexDbPath } from "./paths";
import { getPage, listPages, searchMemory } from "./retrieval";
import { reindexAll } from "./indexer";
import { embedOne } from "./embeddings";
import { createPage, appendToPage } from "./writes";
import { validateLineage, traceLineage } from "./lineage";
import { EmbedQueue } from "./embed-queue";

// ---------------------------------------------------------------------------
// Tool definitions — JSON-Schema for the agent.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_page",
    description:
      "Read a single zbrain page by slug. Deterministic, ~0.1ms. Prefer this over search_memory when you know the page name. Returns frontmatter + body + outbound links.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Page slug, e.g. 'business/acme'" },
      },
      required: ["slug"],
    },
  },
  {
    name: "list_pages",
    description:
      "Browse zbrain pages by type tag or slug prefix. Returns slug + type + frontmatter summary. Use when you know the domain but not the specific page.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by frontmatter type tag" },
        prefix: { type: "string", description: "Filter by slug prefix, e.g. 'business/'" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: "search_memory",
    description:
      "Semantic search across zbrain blocks. Returns top-k with score + lineage attribution + pending_embeddings count. Use when you don't know which page covers the topic. Slower than get_page (~50ms with embedding API call).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query" },
        type: { type: "string", description: "Optional: filter by page type tag" },
        k: { type: "integer", minimum: 1, maximum: 50, default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "create_page",
    description:
      "Create a new zbrain page. Errors if the slug already exists (use append_to_page in that case). lineage_meta REQUIRED with non-empty agent_id and tool_call_id.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "New page slug, e.g. 'business/acme/q3-expansion'" },
        type: { type: "string", description: "Optional advisory type tag" },
        frontmatter: { type: "object", description: "Optional frontmatter object (any shape)" },
        body: { type: "string", description: "Markdown body" },
        lineage_meta: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            tool_call_id: { type: "string" },
            orchestrator_session_id: { type: "string" },
            parent_agent_id: { type: "string" },
            spawn_chain: { type: "array", items: { type: "string" } },
          },
          required: ["agent_id", "tool_call_id"],
        },
      },
      required: ["slug", "body", "lineage_meta"],
    },
  },
  {
    name: "append_to_page",
    description:
      "Append content to an existing zbrain page. section is an optional H2 heading; if missing, created at end of body. lineage_meta REQUIRED with non-empty agent_id and tool_call_id.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        section: { type: "string", description: "Optional H2 heading hint" },
        content: { type: "string", description: "Markdown content to append" },
        lineage_meta: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            tool_call_id: { type: "string" },
            orchestrator_session_id: { type: "string" },
            parent_agent_id: { type: "string" },
            spawn_chain: { type: "array", items: { type: "string" } },
          },
          required: ["agent_id", "tool_call_id"],
        },
      },
      required: ["slug", "content", "lineage_meta"],
    },
  },
  {
    name: "trace_lineage",
    description:
      "Return the spawn chain that produced each block on a page. The demo flex — answers 'where did this fact come from? which agent figured it out?' Optional `since` is a Unix epoch seconds filter.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        since: { type: "integer", description: "Optional Unix epoch seconds; if set, only entries after this time" },
      },
      required: ["slug"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Server lifecycle.
// ---------------------------------------------------------------------------

function ensureDataDir() {
  const path = indexDbPath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dataDir(), { recursive: true });
  }
}

let _db: Database | null = null;
function db(): Database {
  if (_db) return _db;
  ensureDataDir();
  _db = openDb(indexDbPath());
  return _db;
}

// ---------------------------------------------------------------------------
// Tool handlers — small adapters around src/retrieval.ts.
// ---------------------------------------------------------------------------

type JsonObject = { [k: string]: unknown };

function ok(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function err(message: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    isError: true,
  };
}

async function handle(name: string, args: JsonObject) {
  switch (name) {
    case "get_page": {
      const slug = String(args.slug ?? "");
      if (!slug) return err("missing required arg: slug");
      const page = getPage(db(), slug);
      return ok({ ok: true, page });
    }
    case "list_pages": {
      const opts: { type?: string; prefix?: string; limit?: number } = {};
      if (typeof args.type === "string") opts.type = args.type;
      if (typeof args.prefix === "string") opts.prefix = args.prefix;
      if (typeof args.limit === "number") opts.limit = args.limit;
      const pages = listPages(db(), opts);
      return ok({ ok: true, pages });
    }
    case "search_memory": {
      const query = String(args.query ?? "");
      if (!query) return err("missing required arg: query");
      const opts: { type?: string; k?: number } = {};
      if (typeof args.type === "string") opts.type = args.type;
      if (typeof args.k === "number") opts.k = args.k;
      const queryEmbedding = await embedOne(query);
      const response = searchMemory(db(), queryEmbedding, opts);
      return ok({ ok: true, ...response });
    }
    case "create_page": {
      const validation = validateLineage(args.lineage_meta as any);
      if (!validation.ok) return err(validation.error);
      const slug = String(args.slug ?? "");
      if (!slug) return err("missing required arg: slug");
      const body = typeof args.body === "string" ? args.body : "";
      const result = await createPage(db(), {
        slug,
        type: typeof args.type === "string" ? args.type : undefined,
        frontmatter: (args.frontmatter as Record<string, unknown>) ?? undefined,
        body,
        lineage: validation.meta,
      });
      if (!result.ok) return err(result.error);
      return ok({ ok: true, slug: result.slug, block_ords: result.block_ords });
    }
    case "append_to_page": {
      const validation = validateLineage(args.lineage_meta as any);
      if (!validation.ok) return err(validation.error);
      const slug = String(args.slug ?? "");
      if (!slug) return err("missing required arg: slug");
      const content = typeof args.content === "string" ? args.content : "";
      if (!content) return err("missing required arg: content");
      const result = await appendToPage(db(), {
        slug,
        section: typeof args.section === "string" ? args.section : undefined,
        content,
        lineage: validation.meta,
      });
      if (!result.ok) return err(result.error);
      return ok({ ok: true, slug: result.slug, block_ord: result.block_ord });
    }
    case "trace_lineage": {
      const slug = String(args.slug ?? "");
      if (!slug) return err("missing required arg: slug");
      const since = typeof args.since === "number" ? args.since : undefined;
      const entries = traceLineage(db(), slug, since);
      return ok({ ok: true, slug, entries });
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}

async function main() {
  // On startup: reindex so disk and index are aligned, run embed-queue
  // crash-recovery sweep, then start the embed loop. All cheap when
  // nothing has changed.
  ensureDataDir();
  const handle_db = db();
  await reindexAll(handle_db);

  const queue = new EmbedQueue(handle_db);
  const swept = queue.startupSweep();
  if (swept > 0) {
    console.error(`[zbrain] startup sweep re-enqueued ${swept} orphan blocks for embedding`);
  }
  queue.start();

  // Drain the queue gracefully when the parent process closes stdin.
  const shutdown = async () => {
    await queue.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = new Server(
    {
      name: "zbrain",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      return await handle(name, args as JsonObject);
    } catch (e: any) {
      return err(`${name} failed: ${e?.message ?? String(e)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until stdin closes.
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
