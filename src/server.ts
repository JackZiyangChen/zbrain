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
    default:
      return err(`unknown tool: ${name}`);
  }
}

async function main() {
  // On startup, run a reindex so disk and index are aligned.
  // (Cheap when nothing has changed thanks to body_sha skip.)
  ensureDataDir();
  const handle_db = db();
  await reindexAll(handle_db);

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
