---
type: zbrain-system
name: zbrain TOOL slice
description: Tool-usage slice intended for injection into OpenClaw's TOOL.md. The WHEN and HOW for each MCP tool. Pairs with soul.md (the WHAT and WHY).
---

# zbrain MCP tools

## Read path (use these first)

- **`get_page(slug)`** — you know the page name. Faster, deterministic, prefer over search.
- **`list_pages(type?, prefix?)`** — browse a domain. Returns slugs + frontmatter summary.
- **`search_memory(query, type?, k=5)`** — you don't know which page covers the topic. Returns top-k blocks with score, lineage attribution, and a `pending_embeddings` count. If `pending_embeddings > 0`, the index is mid-rebuild; consider retrying or lowering confidence in zero-result responses.
- **`trace_lineage(slug, since?)`** — user asks where a fact came from or which agent figured something out.

## Write path

- **`create_page(slug, type?, frontmatter?, body, lineage_meta)`** — topic doesn't fit any existing page. Pick a clear slug like `business/acme/q3-expansion` or `trading/kalshi-vol-thesis`. Slug is forward-slash separated, no whitespace, no `..`.
- **`append_to_page(slug, section?, content, lineage_meta)`** — clearly-related existing page exists. `section` is an optional H2 heading hint; the heading is created at the end if missing.

## Decision flow

1. Start of any task → `list_pages(type)` if domain is known, else `search_memory(query)`.
2. Before suggesting a new approach → check related pages for prior thinking via `get_page` or `search_memory`.
3. Before creating a new page → confirm an existing page doesn't already cover the topic.
4. After producing a finding worth preserving → `create_page` (new topic) or `append_to_page` (existing).

## lineage_meta shape

```json
{
  "agent_id": "<your session id>",
  "tool_call_id": "<this MCP call's id>"
}
```

The orchestrator injects `orchestrator_session_id`, `parent_agent_id`, and `spawn_chain` from environment variables. You do NOT need to populate those — and if you do, the server prefers your explicit values.

## Page-type conventions (advisory, not enforced)

`business`, `trading`, `goal`, `client`, `todo`, `thought`, `dream`. You can use any string. New types appear simply by writing them. The type field is a soft tag for filtering, not a schema enforcer.

## Sentinel agent ids you may see (but don't write as)

- `human` — manual file edits caught by the file watcher.
- `openclaw-watcher` — bridge ingests of OpenClaw memory writes.
- `dream` — nightly consolidation process.
- `dream-review` — the user accepting a dream proposal via `zbrain dream-review`.

You write as your own agent_id. Never spoof a sentinel.
