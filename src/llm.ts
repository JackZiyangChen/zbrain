/**
 * LLM client abstraction for the dream pipeline. Lets us swap providers
 * via env (`ZBRAIN_DREAM_LLM`) without leaking SDK shapes into dream.ts.
 *
 * For tests / dev: `ZBRAIN_DREAM_LLM=fake` returns a deterministic
 * canned response with the expected structure (summary sections + a few
 * PROPOSE: lines based on input).
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type LlmCallArgs = {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
};

export type LlmResult = {
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  model: string;
};

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-5.4";

export async function callLlm(args: LlmCallArgs): Promise<LlmResult> {
  const provider = (process.env.ZBRAIN_DREAM_LLM ?? "anthropic").toLowerCase();
  if (provider === "fake") return fakeLlm(args);
  if (provider === "anthropic") return callAnthropic(args);
  if (provider === "openai") return callOpenAI(args);
  throw new Error(
    `Unknown ZBRAIN_DREAM_LLM=${provider}; expected anthropic|openai|fake`,
  );
}

async function callAnthropic(args: LlmCallArgs): Promise<LlmResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set. Set ZBRAIN_DREAM_LLM=fake for tests.");
  }
  const client = new Anthropic({ apiKey: key });
  const model = process.env.ZBRAIN_DREAM_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const response = await client.messages.create({
    model,
    max_tokens: args.maxTokens ?? 4000,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
  });
  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  return {
    text,
    model,
    usage: {
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
    },
  };
}

async function callOpenAI(args: LlmCallArgs): Promise<LlmResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not set. Set ZBRAIN_DREAM_LLM=fake for tests.");
  }
  const client = new OpenAI({ apiKey: key });
  const model = process.env.ZBRAIN_DREAM_MODEL ?? DEFAULT_OPENAI_MODEL;
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: args.maxTokens ?? 4000,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userMessage },
    ],
  });
  const text = response.choices[0]?.message?.content ?? "";
  return {
    text,
    model,
    usage: {
      input_tokens: response.usage?.prompt_tokens,
      output_tokens: response.usage?.completion_tokens,
    },
  };
}

/**
 * Deterministic fake LLM for tests. Echoes a fixed-shape summary plus a
 * couple of PROPOSE: lines derived from the user message — enough for the
 * dream pipeline plumbing to be exercised end-to-end without a real API.
 */
function fakeLlm(args: LlmCallArgs): LlmResult {
  const seenSlugs = Array.from(
    args.userMessage.matchAll(/(?<=Page: )([a-zA-Z0-9_\-./]+)/g),
  )
    .map((m) => m[1])
    .filter((s): s is string => typeof s === "string");
  const proposeLines = seenSlugs.slice(0, 2).map(
    (slug) =>
      `PROPOSE: append to ${slug} — fake-llm consolidation — Synthesized note from today's activity on ${slug}.`,
  );

  const text = [
    "## Summary",
    "Fake LLM produced a deterministic summary of today's brain activity.",
    "",
    "## Key entities",
    seenSlugs.length > 0 ? seenSlugs.map((s) => `- ${s}`).join("\n") : "- none",
    "",
    "## Themes",
    "- ambient agent activity",
    "",
    "## Decisions",
    "- (fake LLM made no decisions)",
    "",
    "## Open threads",
    "- (fake LLM has no real open threads)",
    "",
    "## Patterns",
    "- (fake LLM observes deterministic patterns by definition)",
    "",
    ...proposeLines,
  ].join("\n");

  return {
    text,
    model: "fake",
    usage: { input_tokens: args.userMessage.length, output_tokens: text.length },
  };
}
