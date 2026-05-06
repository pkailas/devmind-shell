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
- Surfaces the full DevMind tool suite (file reads, patches, shell execution, search, memory) via an Ink/React terminal UI with streaming token output and a multi-round agentic loop

## Status

**Stage 11 complete.** All four phases shipped (`phase-a` → `phase-d` tags).

| Phase | Outcome |
|---|---|
| A | First contact: SSE gate, scaffold, MCP client connects |
| B | Streaming chat, `<Static>` + `<ActiveTurn>`, reasoning_content rendering, Esc/Ctrl+C cancel |
| C | Agentic loop, sequential tool dispatch, McpServer crash recovery, read→patch→run cycle |
| D | Production hardening: config + env var resolution, path discovery, context-budget trim, tool-call timeout, graceful shutdown, color theming |

Phase summaries in `docs/Stage11-Phase{A,B,C,D}-Summary.md`.

## Quick start

```sh
git clone https://github.com/pkailas/devmind-shell
cd devmind-shell
bun install

# Optional: tell the shell where DevMind.McpServer.exe lives.
# If you have DevMind cloned as a sibling repo and built (Release or Debug, net8.0),
# the shell finds it automatically.
export DEVMIND_MCP_SERVER_PATH="C:/path/to/DevMind.McpServer.exe"

# Optional: configure the LLM endpoint.
export DEVMIND_BASE_URL="http://10.0.0.15:8080/v1"
export DEVMIND_MODEL="<your model id>"

bun run dev     # interactive agentic shell
bun run smoke   # MCP smoke test (connect, list tools, exit)
bun run gate    # SSE gate (re-run streaming verification)
```

## Configuration

Three layers, highest priority first:

1. **Environment variables** (override everything)
2. **Config file** at the platform-correct location (see below)
3. **Built-in defaults**

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DEVMIND_BASE_URL` | OpenAI-compatible endpoint URL | `http://10.0.0.15:8080/v1` |
| `DEVMIND_API_KEY` | API key (`lm-studio` works for local llama-server) | `lm-studio` |
| `DEVMIND_MODEL` | Model id passed in chat completion requests | `G:\models\GEMMA4\google_gemma-4-31B-it-Q8_0.gguf` |
| `DEVMIND_MCP_SERVER_PATH` | Absolute path to `DevMind.McpServer.exe` | (resolved via path-resolution chain) |
| `DEVMIND_TOOL_TIMEOUT_MS` | Non-streaming tool-call timeout | `30000` |
| `DEVMIND_CONFIG_PATH` | Override config-file location | (platform default) |

### Config file

Located at:

- **Windows**: `%APPDATA%\devmind\shell.json` → `C:\Users\<user>\AppData\Roaming\devmind\shell.json`
- **macOS**: `~/Library/Application Support/devmind/shell.json`
- **Linux**: `$XDG_CONFIG_HOME/devmind/shell.json` or `~/.config/devmind/shell.json`

Override the location with `DEVMIND_CONFIG_PATH=<absolute-path>`.

Schema (all fields optional):

```json
{
  "baseURL": "http://10.0.0.15:8080/v1",
  "apiKey": "lm-studio",
  "model": "your-model-id",
  "mcpServerPath": "C:/path/to/DevMind.McpServer.exe",
  "toolTimeoutMs": 30000
}
```

### McpServer path resolution chain

The shell looks for `DevMind.McpServer.exe` in this order:

1. `DEVMIND_MCP_SERVER_PATH` env var
2. `mcpServerPath` field in the config file
3. Adjacent-build sibling repo (Release first, then Debug):
   `../DevMind/DevMind.McpServer/bin/{Release|Debug}/net8.0/DevMind.McpServer.exe`
4. Hard error printing the entire chain that was tried

The adjacent-build convention assumes both repos are cloned siblings — convenient on a developer's machine where DevMind and DevMindShell live next to each other.

### Project-context files

On startup, the shell looks for these files in the cwd and injects their content into the system prompt. Precedence order if multiple exist:

1. `DevMind.md` (primary, project-native)
2. `CLAUDE.md` (Claude Code convention)
3. `AGENTS.md` (GitHub Copilot convention)

The first file found is the primary context; later files are appended as supplementary blocks. Each file is capped at 32 KB; larger files are truncated with a marker.

## Runtime

**Primary**: Bun 1.3.13 — verified on Windows x64 (Beast) via the Stage 11 Phase A spike. Cold-start advantage matters for interactive developer tools.

**Fallback**: Node 20+ via `tsx` (kept as a devDependency). To use Node, run `npx tsx src/index.tsx`. The project structure is runtime-agnostic.

## Architecture

The shell owns the agentic loop:

- Streaming chat completions go directly to llama-server via the `openai` npm package.
- Tool calls dispatch to `DevMind.McpServer.exe` via the `@modelcontextprotocol/sdk` stdio client.
- Multi-turn conversation history accumulates in the loop instance.
- Context budget rolling-window trim activates at 80% / 95% of the configured 131K-token ceiling.
- Graceful shutdown on SIGINT/SIGTERM via `src/util/lifecycle.ts`.

See `../DevMind/docs/Stage11-InkShell-Discovery.md` for the design rationale.

## Repo structure

```
DevMindShell/
├── src/
│   ├── llm/                  # streaming OpenAI client + non-streaming wrapper
│   │   ├── StreamingClient.ts
│   │   └── CompletionClient.ts
│   ├── mcp/                  # MCP SDK wrapper (Stdio client + reconnect)
│   │   └── McpClient.ts
│   ├── loop/                 # agentic loop + context budget
│   │   ├── AgenticLoop.ts
│   │   └── contextBudget.ts
│   ├── ui/                   # color theme
│   │   └── theme.ts
│   ├── util/                 # config, path conv, lifecycle, project context, startup
│   │   ├── config.ts
│   │   ├── lifecycle.ts
│   │   ├── path.ts
│   │   ├── projectContext.ts
│   │   └── startup.ts
│   ├── index.tsx             # interactive shell entry point
│   └── smoke.tsx             # MCP smoke test entry point
├── scripts/                  # one-shot verification spikes
│   ├── sse-gate.ts           #   Phase A SSE streaming
│   ├── streaming-smoke.ts    #   Phase B streaming client
│   ├── static-stress.tsx     #   Phase B §9.5 Static isolation
│   ├── cancel-test.ts        #   Phase B §9.1 cancel latency
│   ├── loop-smoke.ts         #   Phase C agentic loop
│   ├── crash-test.ts         #   Phase C §9.3 crash recovery
│   ├── progress-smoke.ts     #   Phase C progress streaming
│   ├── cycle-test.ts         #   Phase C read→patch→run cycle + §9.4
│   ├── shutdown-test.ts      #   Phase D graceful shutdown
│   ├── config-test.ts        #   Phase D path-resolution chain
│   ├── context-test.ts       #   Phase D project-context discovery
│   ├── budget-test.ts        #   Phase D context-budget trim
│   └── timeout-test.ts       #   Phase D §9.3 timeout follow-up
└── docs/
    ├── Stage11-PhaseA-Summary.md
    ├── Stage11-PhaseB-Summary.md
    ├── Stage11-PhaseC-Summary.md
    └── Stage11-PhaseD-Summary.md
```

## Keybinds

- **Enter** — submit input
- **Shift+Enter** — newline in input
- **Esc** — cancel in-flight stream / tool dispatch
- **Ctrl+C** — exit (graceful shutdown: aborts active work, terminates McpServer, exits)

## License

Copyright (c) iOnline Consulting LLC. All rights reserved.
