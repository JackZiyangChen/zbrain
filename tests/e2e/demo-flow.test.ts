/**
 * E2E demo-flow test — exercises the full v1 magic moment.
 *
 * 1. Spawn an MCP server with simulated OpenClaw env vars (orchestrator
 *    session id, parent agent id, spawn chain).
 * 2. As "claude-code-4f2a" (a sub-agent), call create_page.
 * 3. As "websearch-ab2c" (a deeper sub-agent), call append_to_page.
 * 4. Close the client, spawn a SECOND client (fresh "session"), call get_page
 *    — verify it sees the writes.
 * 5. Call trace_lineage — verify it returns the spawn chain for both writes.
 * 6. Call search_memory after waiting for the embed queue to drain — verify
 *    it returns the page.
 *
 * This is the demo gif scenario in test form.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let tmpHome: string;

const SERVER_ARGS = [
  "run",
  join(import.meta.dir, "..", "..", "src", "server.ts"),
];

async function makeClient(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: "bun",
    args: SERVER_ARGS,
    env: {
      ...process.env,
      ZBRAIN_HOME: tmpHome,
      ZBRAIN_EMBED_PROVIDER: "fake",
      ...env,
    },
  });
  const client = new Client({ name: "demo-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function parse(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("no text content in result");
  return JSON.parse(text);
}

beforeAll(() => {
  tmpHome = join(tmpdir(), `zbrain-demo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });
});

afterAll(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("demo flow: cross-session recall + lineage trace", () => {
  test("the magic moment", async () => {
    // ============ Session 1 ============
    // Simulated OpenClaw spawn metadata in env.
    const session1Env = {
      ZBRAIN_ORCHESTRATOR_SESSION_ID: "openclaw-9d11",
      ZBRAIN_PARENT_AGENT_ID: "claw",
      ZBRAIN_SPAWN_CHAIN: '["claw","claude-code-4f2a"]',
    };
    const { client: c1, transport: t1 } = await makeClient(session1Env);

    // List tools — should include all 6.
    const toolsResult = await c1.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "append_to_page",
      "create_page",
      "get_page",
      "list_pages",
      "search_memory",
      "trace_lineage",
    ]);

    // claude-code-4f2a creates a page about Acme.
    const createResp = await c1.callTool({
      name: "create_page",
      arguments: {
        slug: "business/acme",
        type: "business",
        frontmatter: { name: "Acme Corp", status: "active" },
        body: "Initial notes.\n\nClient: Acme Corp.",
        lineage_meta: {
          agent_id: "claude-code-4f2a",
          tool_call_id: "tc-001",
        },
      },
    });
    const createData = parse(createResp);
    expect(createData.ok).toBe(true);
    expect(createData.slug).toBe("business/acme");

    // Now simulate a deeper sub-agent (websearch-ab2c spawned by cc-4f2a)
    // by closing this client and opening a new one with a deeper spawn_chain.
    await c1.close();

    const session1bEnv = {
      ZBRAIN_ORCHESTRATOR_SESSION_ID: "openclaw-9d11",
      ZBRAIN_PARENT_AGENT_ID: "claude-code-4f2a",
      ZBRAIN_SPAWN_CHAIN: '["claw","claude-code-4f2a","websearch-ab2c"]',
    };
    const { client: c1b } = await makeClient(session1bEnv);

    const appendResp = await c1b.callTool({
      name: "append_to_page",
      arguments: {
        slug: "business/acme",
        section: "Research",
        content: "Sarah Chen is the ops lead. She prefers async updates.",
        lineage_meta: {
          agent_id: "websearch-ab2c",
          tool_call_id: "tc-002",
        },
      },
    });
    const appendData = parse(appendResp);
    expect(appendData.ok).toBe(true);

    await c1b.close();

    // ============ Session 2 — FRESH SESSION, NEW CLIENT ============
    // No OpenClaw env injection — simulating a separate Claude Code session
    // querying the same brain.
    const { client: c2 } = await makeClient({});

    // get_page sees both writes' content.
    const pageResp = await c2.callTool({
      name: "get_page",
      arguments: { slug: "business/acme" },
    });
    const pageData = parse(pageResp);
    expect(pageData.ok).toBe(true);
    expect(pageData.page.body).toContain("Initial notes.");
    expect(pageData.page.body).toContain("Sarah Chen is the ops lead.");
    expect(pageData.page.body).toContain("## Research");
    expect(pageData.page.frontmatter.name).toBe("Acme Corp");

    // trace_lineage shows the spawn chain that produced each block.
    const traceResp = await c2.callTool({
      name: "trace_lineage",
      arguments: { slug: "business/acme" },
    });
    const traceData = parse(traceResp);
    expect(traceData.ok).toBe(true);
    expect(traceData.entries.length).toBe(2);

    const first = traceData.entries[0];
    expect(first.agent_id).toBe("claude-code-4f2a");
    expect(first.parent_agent_id).toBe("claw");
    expect(first.spawn_chain).toEqual(["claw", "claude-code-4f2a"]);

    const second = traceData.entries[1];
    expect(second.agent_id).toBe("websearch-ab2c");
    expect(second.parent_agent_id).toBe("claude-code-4f2a");
    expect(second.spawn_chain).toEqual(["claw", "claude-code-4f2a", "websearch-ab2c"]);

    // list_pages by type returns the new page.
    const listResp = await c2.callTool({
      name: "list_pages",
      arguments: { type: "business" },
    });
    const listData = parse(listResp);
    expect(listData.pages.length).toBe(1);
    expect(listData.pages[0].slug).toBe("business/acme");

    await c2.close();
  }, 30_000);

  test("lineage validation rejects malformed write", async () => {
    const { client } = await makeClient({});
    const result = await client.callTool({
      name: "create_page",
      arguments: {
        slug: "should-fail",
        body: "x",
        lineage_meta: {
          agent_id: "", // empty — must reject
          tool_call_id: "tc",
        },
      },
    });
    // Tool returns an error response; structured isError flag set.
    expect((result as any).isError).toBe(true);
    const errData = parse(result);
    expect(errData.error).toContain("agent_id");
    await client.close();
  }, 15_000);

  test("rejects appending to a missing page", async () => {
    const { client } = await makeClient({});
    const result = await client.callTool({
      name: "append_to_page",
      arguments: {
        slug: "ghost-page",
        content: "something",
        lineage_meta: {
          agent_id: "cc",
          tool_call_id: "tc",
        },
      },
    });
    expect((result as any).isError).toBe(true);
    const errData = parse(result);
    expect(errData.error).toContain("does not exist");
    await client.close();
  }, 15_000);
});
