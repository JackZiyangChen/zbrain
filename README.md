# zbrain

A personal-Notion-for-agents: a typed, semantic, lineage-aware second brain exposed via the **Model Context Protocol (MCP)**. Built to live alongside [OpenClaw](https://openclaw.dev) (or any MCP-speaking host) as the cross-session memory layer that survives sub-agent spawns, host restarts, and machine reboots.

> **Status:** v1 local install. Single-user, single-machine. Cloud/Docker packaging is v1.5.

---

## Why

Every coding-agent host today has session-local memory and forgets everything between sessions. Notion has structure but nothing knows how to read it. zbrain is the part in the middle: markdown pages on disk (git-friendly, human-editable), a SQLite + `sqlite-vec` index (page-addressed retrieval primary, semantic fallback), and full lineage attribution on every write — so you can ask "which agent figured this out, in which spawn chain?" and get a real answer.

## zbrain vs [gbrain](https://github.com/garrytan/gbrain)

zbrain is heavily inspired by [gbrain](https://github.com/garrytan/gbrain) (Garry Tan) — a typed, MCP-exposed second brain for AI agents, and the prior art that made the page-shaped, agent-first memory model concrete. Credit where it's due: the named-page schema, the "agents install and operate it themselves" posture, and the OpenClaw-friendly MCP surface all originate there. If gbrain fits your setup, use gbrain.

zbrain takes that shape and makes a few opinionated changes for our use case:

- **SQLite-portable, single-file install.** gbrain runs on PGLite or Supabase Postgres. zbrain runs on `bun:sqlite` + `sqlite-vec` — one `index.db` file, no server, no auth, no migration tool. *Why:* this is the prototyping/eval profile. You can clone the repo, point it at a folder, and have a working second brain in under a minute, with no infra to provision. The whole state of the system is one directory you can `tar` up and inspect.
- **Markdown-on-disk as source of truth, SQLite as the index.** Atomic-rename markdown → SQLite txn → enqueue embedding. *Why:* readability and auditability. Pages are plain `.md` files in a git-friendly tree — humans (and reviewers, and compliance) can `cat` them, diff them, and grep them without touching a database. Crash-safe by construction: the index can always be rebuilt from `pages/`, never the other way around. This is the angle that matters most for any future enterprise adopter — every byte the agent wrote is sitting in a file you can read.
- **Server-enforced spawn-chain lineage.** Every write requires `agent_id` + `tool_call_id`; the server merges `orchestrator_session_id`, `parent_agent_id`, and `spawn_chain` from env vars and stores them on the row. `trace_lineage(slug)` walks the chain. *Why:* in an orchestrator world you need to answer "which agent, in which spawn tree, wrote this?" — for debugging, for trust, and again for audit. gbrain attributes by source; zbrain attributes by call graph.
- **Smaller MCP surface, page-addressed first.** Six tools (`get_page`, `list_pages`, `search_memory`, `create_page`, `append_to_page`, `trace_lineage`) instead of 30+. *Why:* fewer tools = a tighter contract for agents to learn and for us to test end-to-end. Slug-first retrieval means the cheap path is deterministic and the expensive semantic search is the fallback, not the default.
- **Dream consolidation as a built-in nightly batch.** A scheduled LLM pass summarises the day into `pages/dream/<date>.md` and emits append proposals for triage. *Why:* the only LLM the system invokes on its own runs once a day on a budget — no surprise spend, easy to evaluate against fixtures, and the output is just more markdown sitting next to everything else.

Same neighbourhood, narrower scope, different trade-offs. gbrain is the broader, more capable system; zbrain is the small, readable, auditable one with lineage baked in — easier to stand up for prototyping today, and easier to defend in a review later.

## What's in the box

- **MCP server** with five tools — `get_page`, `list_pages`, `search_memory`, `create_page`, `append_to_page`, plus `trace_lineage` for the spawn-chain flex.
- **Lineage validation** — server-enforced. Agents supply `agent_id` + `tool_call_id`; the orchestrator-side env vars (`ZBRAIN_ORCHESTRATOR_SESSION_ID`, `ZBRAIN_PARENT_AGENT_ID`, `ZBRAIN_SPAWN_CHAIN`) merge in automatically.
- **Atomic disk-first writes** — markdown lands on disk before SQLite, so a crash never leaves the index ahead of the source of truth.
- **Dream pipeline** — nightly consolidation that summarises the day into `pages/dream/<date>.md` and emits append proposals for triage via `zbrain dream-review`.
- **Embed queue** — async background coroutine; `pending_embeddings` count is reported in every `search_memory` response so callers know when the index is mid-rebuild.
- **CLI** — `init`, `dream`, `trace`, `dream-review`, `doctor`.

## Stack (locked)

Bun ≥ 1.3 · `bun:sqlite` (NOT better-sqlite3) · sqlite-vec 0.1.9+ · `marked` + `gray-matter` · `@modelcontextprotocol/sdk` · `gpt-tokenizer` · `bun test`.

> ⚠️ **libsqlite3 prerequisite.** Bun's bundled libsqlite3 has `SQLITE_OMIT_LOAD_EXTENSION` set on every platform, so zbrain points it at a system-provided libsqlite3 via `Database.setCustomSQLite()`. Auto-resolved on first run; override with `ZBRAIN_SQLITE_LIB`. Per-platform install:
> - **macOS:** `brew install sqlite` (Homebrew lib is auto-detected)
> - **Debian / Ubuntu:** `apt-get install -y libsqlite3-0 libsqlite3-dev`
> - **RHEL / Fedora:** `dnf install -y sqlite-libs sqlite-devel`
> - **Alpine:** workable but not recommended — `sqlite-vec`'s prebuilt binary is glibc-linked. Use a glibc base image (Debian/Ubuntu) for the OpenClaw container.

---

## Install

```bash
# 1. Install a libsqlite3 with extension loading enabled (see prerequisite above)
#    macOS:        brew install sqlite
#    Ubuntu/Deb:   sudo apt-get install -y libsqlite3-0 libsqlite3-dev
#    RHEL/Fedora:  sudo dnf install -y sqlite-libs sqlite-devel

git clone https://github.com/JackZiyangChen/zbrain.git
cd zbrain
bun install
cp .env.example .env                                 # fill in API keys
bun run spike:vec                                    # confirm sqlite-vec loads
bun run bin/zbrain init                              # scaffold pages/ + .zbrain/
bun test                                             # 99/99 should pass
```

## First five minutes

```bash
# 1. Start the MCP server (stdio transport)
bun run dev

# 2. From another terminal, run the dream pipeline
bun run bin/zbrain dream

# 3. Trace the spawn chain on any page
bun run bin/zbrain trace business/orbital

# 4. Triage the day's proposals
bun run bin/zbrain dream-review --list
bun run bin/zbrain dream-review --apply 0

# 5. Sanity-check the install
bun run bin/zbrain doctor
```

## Filesystem layout

```
zbrain/
  pages/                           # source of truth, git-friendly
    zbrain/
      identity.md                  # full agent prompt (combined SOUL + TOOL)
      soul.md                      # SOUL slice — for OpenClaw SOUL.md
      tool.md                      # TOOL slice — for OpenClaw TOOL.md
      dream-prompt.md              # dream LLM prompt
    business/                      # agents create domains as needed
    trading/
    dream/                         # auto-generated daily summaries
  .zbrain/
    index.db                       # SQLite + sqlite-vec
    dream-proposals/<date>.json    # surfaced via `zbrain dream-review`
  src/                             # MCP server, indexer, retrieval, lineage, dream
  bin/zbrain                       # CLI entrypoint
```

## Architectural rules (the non-negotiables)

1. **bun:sqlite, not better-sqlite3.** Confirmed incompatible (Bun #4290).
2. **Disk first, SQLite second.** Atomic-rename markdown → SQLite txn → enqueue embedding.
3. **Lineage is server-enforced.** A write missing `agent_id` or `tool_call_id` rejects.
4. **No symlink with OpenClaw.** zbrain has its own `pages/` dir; the OpenClaw bridge is a one-way file watcher with sentinel `agent_id="openclaw-watcher"`.
5. **Type field is advisory.** One `pages` table, freeform `frontmatter_json`. New page types appear by writing them.
6. **Page-addressed retrieval primary, semantic fallback.** Agents prefer `get_page("slug")`; reach for `search_memory` only when the slug is unknown.

## Wiring into OpenClaw (or any MCP host)

See [`DEPLOY.md`](./DEPLOY.md) for the full deployment guide, including the env-var contract and the OpenClaw MCP-registration snippet.

## Tests

```bash
bun test                  # full suite (99 tests, ~5s)
bun test:e2e              # MCP server end-to-end + lineage E2E
bun run eval:dream        # dream-prompt regression gate (run before any prompt edit)
```

## Authoritative docs

- `~/.gstack/projects/zbrain/jackchen-no-branch-design-20260426-105721.md` — design doc (architecture, contracts, decision rationale).
- `CLAUDE.md` — agent-facing rules and stack pins.
- `BACKLOG.md` — the running checklist.

## License

[GPL-2.0](./LICENSE). zbrain is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 as published by the Free Software Foundation. Modifications and derivative works must remain GPL-2.0.
