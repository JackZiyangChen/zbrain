/**
 * E2E test for the zbrain MCP server.
 *
 * Spawns the server in a subprocess (stdio transport), connects via the MCP
 * SDK client, exercises the read-side tools end-to-end. Uses ZBRAIN_HOME
 * pointing at a fresh tmpdir + ZBRAIN_EMBED_PROVIDER=fake so no API key
 * is needed.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let tmpHome: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  tmpHome = join(tmpdir(), `zbrain-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages", "business"), { recursive: true });
  mkdirSync(join(tmpHome, "pages", "trading"), { recursive: true });

  // Seed three pages with different types.
  writeFileSync(
    join(tmpHome, "pages", "business", "acme.md"),
    `---\ntype: business\nname: Acme Corp\nstatus: active\n---\n\nAcme is a logistics company.\n\nSarah Chen is the ops lead.`,
  );
  writeFileSync(
    join(tmpHome, "pages", "trading", "kalshi-vol.md"),
    `---\ntype: trading\nname: Kalshi vol thesis\n---\n\nPolymarket volatility correlates with election timing.`,
  );
  writeFileSync(
    join(tmpHome, "pages", "scratch.md"),
    `Plain text page, no frontmatter.\n\nJust a thought.`,
  );

  // Spawn the server.
  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "server.ts")],
    env: {
      ...process.env,
      ZBRAIN_HOME: tmpHome,
      ZBRAIN_EMBED_PROVIDER: "fake",
    },
  });

  client = new Client({ name: "zbrain-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
});

afterAll(async () => {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function parseToolResponse(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("no text content in result");
  return JSON.parse(text);
}

describe("MCP server E2E", () => {
  test("listTools returns the read-side tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_page", "list_pages", "search_memory"]);
  });

  test("get_page returns seeded page with frontmatter", async () => {
    const result = await client.callTool({
      name: "get_page",
      arguments: { slug: "business/acme" },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
    expect(data.page.slug).toBe("business/acme");
    expect(data.page.type).toBe("business");
    expect(data.page.frontmatter.name).toBe("Acme Corp");
    expect(data.page.body).toContain("Sarah Chen is the ops lead.");
  });

  test("get_page returns null for missing slug", async () => {
    const result = await client.callTool({
      name: "get_page",
      arguments: { slug: "no/such/page" },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
    expect(data.page).toBeNull();
  });

  test("list_pages returns all seeded pages", async () => {
    const result = await client.callTool({
      name: "list_pages",
      arguments: {},
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
    const slugs = data.pages.map((p: any) => p.slug).sort();
    expect(slugs).toEqual(["business/acme", "scratch", "trading/kalshi-vol"]);
  });

  test("list_pages filters by type", async () => {
    const result = await client.callTool({
      name: "list_pages",
      arguments: { type: "business" },
    });
    const data = parseToolResponse(result);
    expect(data.pages.length).toBe(1);
    expect(data.pages[0].slug).toBe("business/acme");
    expect(data.pages[0].frontmatter_summary.name).toBe("Acme Corp");
    expect(data.pages[0].frontmatter_summary.status).toBe("active");
  });

  test("list_pages filters by slug prefix", async () => {
    const result = await client.callTool({
      name: "list_pages",
      arguments: { prefix: "trading/" },
    });
    const data = parseToolResponse(result);
    expect(data.pages.length).toBe(1);
    expect(data.pages[0].slug).toBe("trading/kalshi-vol");
  });

  test("search_memory reports pending_embeddings on a fresh index", async () => {
    // The seeded pages have no embeddings yet (Day 3 will wire the queue).
    // search_memory should report pending_embeddings > 0 and empty results.
    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "logistics company", k: 3 },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
    expect(data.pending_embeddings).toBeGreaterThan(0);
    // No embedded blocks → no hits.
    expect(data.results).toEqual([]);
  });

  test("get_page on a no-frontmatter file returns empty frontmatter", async () => {
    const result = await client.callTool({
      name: "get_page",
      arguments: { slug: "scratch" },
    });
    const data = parseToolResponse(result);
    expect(data.page.slug).toBe("scratch");
    expect(data.page.type).toBeNull();
    expect(data.page.frontmatter).toEqual({});
    expect(data.page.body).toContain("Just a thought.");
  });
});
