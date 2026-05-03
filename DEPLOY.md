# Deploying zbrain

zbrain ships in two phases:

- **v1 (this repo, today):** standalone local install. `bun run dev` exposes the MCP server over stdio. Any MCP-speaking host on the same machine can connect.
- **v1.5 (planned):** Docker sibling-container alongside the local OpenClaw inference sandbox, with a shared volume for `pages/` + `.zbrain/`. Not yet built — see "v1.5 sketch" at the bottom.

This document covers v1.

---

## v1 — local install

### Prerequisites

- macOS (Linux works in principle but is untested for the libsqlite3 path).
- Bun ≥ 1.3.
- Homebrew sqlite — `brew install sqlite`. Required: Bun's bundled libsqlite3 has `SQLITE_OMIT_LOAD_EXTENSION` so `sqlite-vec` cannot load against it.
- An OpenAI API key (embeddings) and either an Anthropic or OpenAI key (dream).

### Install

```bash
git clone https://github.com/jackchen/zbrain.git
cd zbrain
bun install
cp .env.example .env                          # fill keys
bun run spike:vec                             # confirms sqlite-vec loads
bun run bin/zbrain init                       # scaffolds pages/ + .zbrain/
bun test                                      # 99/99
```

### Run modes

zbrain runs in three modes; pick whichever fits the host:

| Command                       | Use when                                        |
|-------------------------------|-------------------------------------------------|
| `bun run dev`                 | MCP host launches it as a stdio child.          |
| `bun run bin/zbrain dream`    | Cron / scheduled task triggers nightly dream.   |
| `bun run bin/zbrain doctor`   | Health check; safe to invoke anytime.           |

### Nightly dream cron

zbrain expects an external scheduler to fire `bin/zbrain dream` once per day. Two options:

**Option A — launchd (macOS local).** Save as `~/Library/LaunchAgents/dev.zbrain.dream.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.zbrain.dream</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>/Users/you/VSCodeProjects/zbrain/bin/zbrain</string>
    <string>dream</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key><string>sk-ant-...</string>
    <key>OPENAI_API_KEY</key><string>sk-...</string>
    <key>ZBRAIN_HOME</key><string>/Users/you/VSCodeProjects/zbrain</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>/tmp/zbrain-dream.log</string>
  <key>StandardErrorPath</key><string>/tmp/zbrain-dream.err</string>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/dev.zbrain.dream.plist`.

**Option B — OpenClaw scheduled task.** If your OpenClaw deployment has a scheduler, register `bun run bin/zbrain dream` as a daily task. Same env-var requirements as launchd.

---

## OpenClaw MCP registration

OpenClaw spawns zbrain as an MCP child process and reads/writes via stdio. The contract has two halves:

### Half 1 — the env-var contract (zbrain side, FROZEN)

zbrain's MCP server reads three env vars on every write and merges them into `lineage_meta`:

| Env var                          | Type           | Example                              |
|----------------------------------|----------------|--------------------------------------|
| `ZBRAIN_ORCHESTRATOR_SESSION_ID` | string         | `openclaw-session-7a2b`              |
| `ZBRAIN_PARENT_AGENT_ID`         | string         | `claw`                               |
| `ZBRAIN_SPAWN_CHAIN`             | JSON array str | `["claw","code-cc-9f3d"]`            |

An agent that supplies explicit `parent_agent_id` / `spawn_chain` in its `lineage_meta` overrides these defaults; otherwise the server uses them. This is verified end-to-end in `tests/e2e/lineage.test.ts`.

### Half 2 — how OpenClaw injects them (TBD pending Spike B)

> ⚠️ **The exact OpenClaw config syntax is not yet confirmed.** Day-0 Spike B (`bun run spike:openclaw`) needs to run inside the actual cloud-gateway → local-Docker inference sandbox to verify how env vars flow from the gateway down into the spawned MCP child. Until then, treat the snippet below as the *expected shape*, not a verified config.

Expected MCP server entry (claude-desktop-style; adapt to OpenClaw's actual config format):

```json
{
  "mcpServers": {
    "zbrain": {
      "command": "bun",
      "args": ["run", "/Users/you/VSCodeProjects/zbrain/src/server.ts"],
      "env": {
        "ZBRAIN_HOME": "/Users/you/VSCodeProjects/zbrain",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "OPENAI_API_KEY": "sk-...",
        "ZBRAIN_ORCHESTRATOR_SESSION_ID": "${session.id}",
        "ZBRAIN_PARENT_AGENT_ID": "${session.parent_agent}",
        "ZBRAIN_SPAWN_CHAIN": "${session.spawn_chain_json}"
      }
    }
  }
}
```

The three `${session.*}` placeholders are the unknowns Spike B answers — what variable-expansion syntax OpenClaw uses, and whether the gateway forwards spawn-chain metadata to the local sandbox at all.

### Identity injection

OpenClaw reads `pages/zbrain/soul.md` and `pages/zbrain/tool.md` and merges them into the workspace's `SOUL.md` and `TOOL.md`, respectively. zbrain ships these slices pre-formatted; nothing in zbrain auto-pushes them — that side is the OpenClaw orchestrator's responsibility.

---

## Doctor / smoke-test after deploy

```bash
bun run bin/zbrain doctor
```

Should print `pages indexed: N`, `blocks pending embedding: 0` (or a small number that drains), and `All checks passed.` If it reports a missing system page or fails the SQLite integrity check, re-run `bun run bin/zbrain init` and check `.env`.

---

## Secrets

- `.env` is git-ignored. Never commit it.
- For OpenClaw, prefer the host's secret-manager (`session.env` injected by the gateway) over a `.env` file on disk inside the container.
- API keys leak via process env to every child the MCP server spawns. The server today spawns no children; if that changes, audit before shipping.

---

## v1.5 sketch (not built)

The intended cloud topology, captured here so it's not lost:

- zbrain runs as a sibling Docker container to OpenClaw's local inference sandbox.
- Shared bind-mounted volume for `pages/` (markdown) and `.zbrain/` (SQLite).
- Network egress allowed for embedding + dream LLM calls.
- Lineage env vars flow gateway → sandbox container → zbrain container via `docker compose` env.
- `Dockerfile` based on `oven/bun:1.3-alpine` + a build step that `apk add sqlite-dev` and copies the extension-loading-enabled libsqlite3 into the image (sidesteps the macOS Homebrew dependency on Linux).

This is logged as a v2 idea in `BACKLOG.md` and gated on Spike B.
