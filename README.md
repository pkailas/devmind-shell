---
doc_type: readme
project: DevMindShell
stage: 11
title: DevMindShell README
verified_date: "2026-05-06"
last_updated: "2026-05-06"
revalidate_after: "2026-11-06"
tech_versions:
  bun: "1.3.13"
  ink: "7.0.2"
  node: "24.15.0"
  mcp_sdk_typescript: "1.29.0"
  openai_npm: "6.36.0"
rag_ready: true
---

# DevMindShell

Owned by **iOnline Consulting LLC**. Companion repo to [DevMind](https://github.com/pkailas/DevMind).

**Remotes**:
- GitHub (public, primary): https://github.com/pkailas/devmind-shell
- Synology NAS (private mirror): `pkailas@vard-nas:/volume1/GIT/devmind-shell.git`

A TypeScript/Ink terminal application that:

- Connects to `DevMind.McpServer.exe` over stdio as an MCP client
- Talks to a locally hosted LLM (Gemma 4 31B via ik_llama.cpp's llama-server) using an OpenAI-compatible API
- Surfaces the full DevMind tool suite (file reads, patches, shell execution, search, memory) as an Ink/React terminal UI

## Status

**Stage 11 Phase A** — first contact. Three subsystems verified:
- Ink renders + accepts input under Bun (verified by `bun run dev`)
- `openai` npm SSE streaming works against llama-server (verified by `bun run gate`, evidence in `scripts/sse-gate-evidence.txt`)
- MCP client connects to McpServer.exe and calls tools (verified by `bun run smoke`)

See `docs/Stage11-PhaseA-Summary.md` for details. The agentic loop, tool dispatch, and streaming UX arrive in Phases B–D.

## Runtime

**Primary**: Bun 1.3.13 — confirmed on the Beast (Windows x64) via the Stage 11 spike. Cold-start advantage matters for an interactive developer tool.

**Fallback**: Node 20+ via `tsx` (kept as a devDependency). To use Node, run `npx tsx src/index.tsx` — but most documentation assumes Bun.

## Quick start

```sh
bun install
bun run smoke   # MCP smoke test: connect, list tools, call list_memory_topics, exit
bun run dev     # Interactive shell: minimal Ink REPL with non-streaming completion
bun run gate    # SSE gate test against llama-server (Phase A verification)
```

The shell expects to find `DevMind.McpServer.exe` at the path configured in `src/index.tsx` — for Phase A this is hardcoded; Phase D adds full path resolution (env var → config → adjacent build → PATH).

## Architecture

The shell owns the agentic loop. Talks to llama-server directly for completions, talks to McpServer for tool execution. See [`../DevMind/docs/Stage11-InkShell-Discovery.md`](../DevMind/docs/Stage11-InkShell-Discovery.md) for the full design.

## Repo structure

```
DevMindShell/
├── src/
│   ├── llm/          # OpenAI-compatible completion client (Phase A: non-streaming)
│   ├── mcp/          # MCP SDK wrapper (StdioClientTransport)
│   ├── util/         # path conversion, helpers
│   ├── index.tsx     # interactive shell entry point
│   └── smoke.tsx     # MCP smoke test entry point
├── scripts/
│   ├── sse-gate.ts             # streaming-verification spike
│   └── sse-gate-evidence.txt   # captured PASS evidence (re-run with `bun run gate`)
└── docs/
    └── Stage11-PhaseA-Summary.md
```

## License

Copyright (c) iOnline Consulting LLC. All rights reserved.
