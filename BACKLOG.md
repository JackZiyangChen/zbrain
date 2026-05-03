# BACKLOG

## Features
- [x] Day 0 Spike A: sqlite-vec extension load on macOS arm64 + Bun
- [ ] Day 0 Spike B: OpenClaw env-var injection capability verification
- [x] Day 1: schema.sql + bun:sqlite + sqlite-vec integration + indexer
- [x] Day 2: MCP server reads (get_page, list_pages, search_memory) + demo path stub
- [x] Day 3: MCP server writes (create_page, append_to_page) + lineage validation + atomic file writes + trace_lineage + embed-queue
- [x] Day 4: dream pipeline (offline batch, no MCP wrapper)
- [x] Day 5: identity prompt + OpenClaw wiring (SOUL.md + TOOL.md slices) + bin/zbrain init + lineage E2E (CLI: init/dream/trace/dream-review/doctor)
- [ ] Day 6: dream-review CLI + trace CLI + doctor + tests + identity iteration
- [x] Day 7: README + .env.example + DEPLOY.md (30s demo gif deferred — needs live recording)
- [ ] OpenClaw bridge: file watcher on ~/.openclaw/workspace/memory/ → sentinel-attributed ingest

## Tech Debt
(none yet — fresh project)

## Ideas
- [ ] v2: real-time reactive watches + cross-page invariants (post-dream architecture)
- [ ] v2: confidence-thresholded auto-apply for dream proposals
- [ ] v2: cross-machine sync (markdown-files-in-a-git-repo)
- [ ] v2: Docker container + docker-compose for cloud-OpenClaw deployment
- [ ] v2: Claude Skill wrapper exposing identity prompt to Claude Code natively
- [ ] v2: PR lineage + dream improvements upstream to gbrain
