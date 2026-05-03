/**
 * Lineage E2E — simulates an OpenClaw spawn injecting orchestrator metadata
 * via environment variables, then a sub-agent making MCP writes. Verifies
 * the spawn chain is reconstructed end-to-end via trace_lineage.
 *
 * Sub-agent only sets agent_id + tool_call_id; the server merges
 * orchestrator_session_id, parent_agent_id, and spawn_chain from env.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let tmpHome: string;
let client: Client;
let transport: StdioClientTransport;

const ORCH_SESSION = "openclaw-session-7a2b";
const PARENT_AGENT = "claw";
const SPAWN_CHAIN = ["claw", "code-cc-9f3d"];

beforeAll(async () => {
  tmpHome = join(tmpdir(), `zbrain-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "pages"), { recursive: true });

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "server.ts")],
    env: {
      ...process.env,
      ZBRAIN_HOME: tmpHome,
      ZBRAIN_EMBED_PROVIDER: "fake",
      // Simulated OpenClaw injection
      ZBRAIN_ORCHESTRATOR_SESSION_ID: ORCH_SESSION,
      ZBRAIN_PARENT_AGENT_ID: PARENT_AGENT,
      ZBRAIN_SPAWN_CHAIN: JSON.stringify(SPAWN_CHAIN),
    },
  });

  client = new Client({ name: "zbrain-lineage-test", version: "0.0.1" }, { capabilities: {} });
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

describe("Lineage E2E with simulated OpenClaw env injection", () => {
  test("create_page populates server-merged orchestrator metadata", async () => {
    const result = await client.callTool({
      name: "create_page",
      arguments: {
        slug: "business/orbital",
        type: "business",
        body: "Orbital Insight is exploring drone-imagery feeds.",
        lineage_meta: {
          agent_id: "code-cc-9f3d",
          tool_call_id: "tc-001",
        },
      },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
  });

  test("append_to_page also picks up the same env-injected chain", async () => {
    const result = await client.callTool({
      name: "append_to_page",
      arguments: {
        slug: "business/orbital",
        content: "Sarah Chen is the ops lead.",
        lineage_meta: {
          agent_id: "code-cc-9f3d",
          tool_call_id: "tc-002",
        },
      },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
  });

  test("trace_lineage reconstructs the full spawn chain end-to-end", async () => {
    const result = await client.callTool({
      name: "trace_lineage",
      arguments: { slug: "business/orbital" },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(true);
    expect(data.entries.length).toBeGreaterThanOrEqual(2);

    for (const entry of data.entries) {
      expect(entry.agent_id).toBe("code-cc-9f3d");
      expect(entry.parent_agent_id).toBe(PARENT_AGENT);
      expect(entry.orchestrator_session_id).toBe(ORCH_SESSION);
      expect(entry.spawn_chain).toEqual(SPAWN_CHAIN);
    }

    const toolCalls = data.entries.map((e: any) => e.tool_call_id).sort();
    expect(toolCalls).toContain("tc-001");
    expect(toolCalls).toContain("tc-002");
  });

  test("explicit lineage in the call wins over env defaults", async () => {
    const overrideChain = ["claw", "code-cc-9f3d", "subagent-explorer-aa11"];
    const result = await client.callTool({
      name: "create_page",
      arguments: {
        slug: "business/override",
        type: "business",
        body: "Sub-agent override test.",
        lineage_meta: {
          agent_id: "subagent-explorer-aa11",
          tool_call_id: "tc-override-1",
          parent_agent_id: "code-cc-9f3d",
          spawn_chain: overrideChain,
        },
      },
    });
    expect(parseToolResponse(result).ok).toBe(true);

    const trace = await client.callTool({
      name: "trace_lineage",
      arguments: { slug: "business/override" },
    });
    const traceData = parseToolResponse(trace);
    expect(traceData.entries.length).toBe(1);
    const entry = traceData.entries[0];
    expect(entry.agent_id).toBe("subagent-explorer-aa11");
    expect(entry.parent_agent_id).toBe("code-cc-9f3d");
    expect(entry.spawn_chain).toEqual(overrideChain);
    // env-injected orchestrator session is still merged when not overridden
    expect(entry.orchestrator_session_id).toBe(ORCH_SESSION);
  });

  test("missing required lineage field rejects the write", async () => {
    const result = await client.callTool({
      name: "create_page",
      arguments: {
        slug: "business/should-fail",
        body: "no lineage fields supplied",
        lineage_meta: { agent_id: "" }, // both required fields invalid
      },
    });
    const data = parseToolResponse(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain("lineage");
  });
});
