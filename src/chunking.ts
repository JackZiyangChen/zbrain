/**
 * Chunking rules for page bodies.
 *
 * Per design doc: split on blank lines, max 800 chars per block, code fences
 * kept whole. Each block becomes a row in `blocks`.
 */

const MAX_CHARS = 800;

/**
 * Chunk markdown body into blocks. Rules:
 * - A block is a paragraph (separated by blank lines).
 * - If a paragraph exceeds MAX_CHARS, split on sentence boundaries (heuristic).
 * - A fenced code block (```...```) is one chunk regardless of length —
 *   never split mid-code.
 */
export function chunkBody(body: string): string[] {
  const out: string[] = [];

  // First pass: tokenize into "code fence" segments and "prose" segments.
  // We walk the body line-by-line tracking whether we're inside a fence.
  const lines = body.split(/\r?\n/);
  type Segment = { kind: "code" | "prose"; text: string };
  const segments: Segment[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flushBuf = (kind: "code" | "prose") => {
    if (buf.length === 0) return;
    const text = buf.join("\n").trim();
    if (text.length > 0) segments.push({ kind, text });
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        // entering fence — flush prose first
        flushBuf("prose");
        inFence = true;
        fenceMarker = fenceMatch[1]!;
        buf.push(line);
      } else if (trimmed.startsWith(fenceMarker)) {
        // closing fence
        buf.push(line);
        flushBuf("code");
        inFence = false;
        fenceMarker = "";
      } else {
        // a fence-like line inside a different fence — keep as-is
        buf.push(line);
      }
    } else {
      buf.push(line);
    }
  }
  // Tail
  flushBuf(inFence ? "code" : "prose");

  for (const seg of segments) {
    if (seg.kind === "code") {
      out.push(seg.text);
      continue;
    }
    // Prose: split on blank lines into paragraphs, then size-cap each.
    const paragraphs = seg.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    for (const para of paragraphs) {
      if (para.length <= MAX_CHARS) {
        out.push(para);
      } else {
        out.push(...sizeCap(para));
      }
    }
  }

  return out;
}

/**
 * Split a too-long paragraph at sentence-ish boundaries, respecting MAX_CHARS.
 */
function sizeCap(text: string): string[] {
  // Heuristic sentence split: '.', '!', '?' followed by whitespace.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current.length === 0) {
      current = s;
      continue;
    }
    if (current.length + 1 + s.length <= MAX_CHARS) {
      current = current + " " + s;
    } else {
      out.push(current);
      current = s;
    }
  }
  if (current.length > 0) out.push(current);

  // Hard fallback: any chunk still > MAX_CHARS gets sliced.
  const final: string[] = [];
  for (const c of out) {
    if (c.length <= MAX_CHARS) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += MAX_CHARS) {
        final.push(c.slice(i, i + MAX_CHARS));
      }
    }
  }
  return final;
}
