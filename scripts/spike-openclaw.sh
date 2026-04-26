#!/usr/bin/env bash
#
# Day 0 Spike B — OpenClaw env-var injection capability verification.
#
# Goal: from inside the OpenClaw inference container (the sandboxed Docker
# where agents actually run), discover which env vars OpenClaw exposes for
# orchestrator session metadata. zbrain's lineage_meta auto-merge depends
# on knowing the real names.
#
# How to run:
#   1. Ensure your OpenClaw is configured to spawn a sub-session.
#   2. Configure OpenClaw's spawn template to mount this script into the
#      inference container at e.g. /workspace/spike-openclaw.sh.
#   3. Have the spawned agent run `bash /workspace/spike-openclaw.sh`.
#   4. Capture its stdout. That output tells us what to plumb into zbrain.
#
# Expected useful env vars (any subset of these is workable):
#   OPENCLAW_SESSION_ID       — orchestrator session id
#   OPENCLAW_PARENT_AGENT_ID  — parent agent (if this is a sub-spawn)
#   OPENCLAW_AGENT_ID         — current agent's id
#   OPENCLAW_SPAWN_CHAIN      — spawn chain (JSON array or comma-separated)
#
# If OpenClaw uses different names, document them and update zbrain's server
# to read those instead.

set -euo pipefail

echo "=== Spike B: OpenClaw env-var inspection ==="
echo "Hostname:  $(hostname)"
echo "User:      $(whoami)"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "PWD:       $(pwd)"
echo

echo "--- OPENCLAW_* env vars ---"
env | grep -E "^OPENCLAW_" | sort || echo "  (none found with OPENCLAW_ prefix)"
echo

echo "--- CLAW* / SESSION* / AGENT* / SPAWN* env vars ---"
env | grep -E "^(CLAW|SESSION|AGENT|SPAWN|ORCHESTRATOR)" | sort || echo "  (none found)"
echo

echo "--- All env vars (for grep'ing) ---"
env | sort

echo
echo "=== Spike B done ==="
echo "Action: copy any orchestrator-identifying env vars from above into"
echo "        zbrain's server.ts as the lineage merge sources."
echo "        Update CLAUDE.md and the design doc with the real var names."
