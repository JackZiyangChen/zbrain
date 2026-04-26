import { test, expect, describe } from "bun:test";
import { chunkBody } from "../src/chunking";

describe("chunkBody", () => {
  test("empty body returns no chunks", () => {
    expect(chunkBody("")).toEqual([]);
    expect(chunkBody("   \n\n   ")).toEqual([]);
  });

  test("single short paragraph is one chunk", () => {
    expect(chunkBody("Hello world.")).toEqual(["Hello world."]);
  });

  test("blank-line separation produces multiple chunks", () => {
    const body = "First paragraph.\n\nSecond paragraph.\n\nThird.";
    expect(chunkBody(body)).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "Third.",
    ]);
  });

  test("code fence is preserved as one chunk regardless of length", () => {
    const longCode = Array(200).fill("console.log('x');").join("\n");
    const body = `Before.\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\nAfter.`;
    const chunks = chunkBody(body);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("Before.");
    expect(chunks[1]).toContain("```ts");
    expect(chunks[1]).toContain("```");
    // The whole code fence is one chunk even though > 800 chars
    expect(chunks[1]!.length).toBeGreaterThan(800);
    expect(chunks[2]).toBe("After.");
  });

  test("paragraph longer than 800 chars splits on sentence boundary", () => {
    const sentence = "This is a sentence with several words in it. ";
    const longPara = sentence.repeat(50); // ~2300 chars
    const chunks = chunkBody(longPara);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
    }
    // All sentences accounted for
    expect(chunks.join(" ").includes(sentence.trim())).toBe(true);
  });

  test("very long single token still gets sliced (hard fallback)", () => {
    const longToken = "a".repeat(2500);
    const chunks = chunkBody(longToken);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
    }
    expect(chunks.join("")).toBe(longToken);
  });

  test("mixed prose + code + prose preserves order", () => {
    const body = `First prose.\n\n\`\`\`\ncode\n\`\`\`\n\nSecond prose.`;
    const chunks = chunkBody(body);
    expect(chunks).toEqual([
      "First prose.",
      "```\ncode\n```",
      "Second prose.",
    ]);
  });

  test("CRLF line endings work", () => {
    const body = "First.\r\n\r\nSecond.\r\n\r\nThird.";
    expect(chunkBody(body)).toEqual(["First.", "Second.", "Third."]);
  });
});
