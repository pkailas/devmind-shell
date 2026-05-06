---
doc_type: operator_guide
project: DevMindShell
stage: 11
title: DevMindShell Operator Guide
verified_date: "2026-05-06"
last_updated: "2026-05-06"
revalidate_after: "2026-08-06"
tech_versions:
  bun: "1.3.13"
  ink: "7.0.2"
  react: "19.2.5"
  node: "24.15.0"
  mcp_sdk_typescript: "1.29.0"
  openai_npm: "6.36.0"
  devmind_mcpserver: "4.2"
status: complete
rag_ready: true
---

# DevMindShell — Operator Guide

Reference document for developers who need to look up specific facts: env vars, config schema, tool signatures, keybinds, timeouts, error codes. Not narrative — tables and definitions only.

---

## 1. Commands

All commands run from the `devmind-shell` repo root with Bun 1.3.13+.

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `bun run src/index.tsx` | Interactive agentic shell |
| `smoke` | `bun run src/smoke.tsx` | MCP connect + list tools + exit |
| `gate` | `bun run scripts/sse-gate.ts` | Re-run Phase A SSE streaming verification |
| `typecheck` | `tsc --noEmit` | TypeScript type check (no emit) |
| `build` | `tsc` | Compile to JS |

**Invocation**:
```sh
bun run dev                 # normal launch
bun run smoke               # connectivity smoke test
bun run typecheck           # before committing
```

---

## 2. Environment Variables

Priority over config file. All are optional; built-in defaults shown.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVMIND_BASE_URL` | `http://10.0.0.15:8080/v1` | OpenAI-compatible endpoint base URL |
| `DEVMIND_API_KEY` | `lm-studio` | Bearer token sent in `Authorization` header |
| `DEVMIND_MODEL` | `G:\models\GEMMA4\google_gemma-4-31B-it-Q8_0.gguf` | Model ID passed in chat completion requests |
| `DEVMIND_MCP_SERVER_PATH` | *(resolved via chain — see §4)* | Absolute path to `DevMind.McpServer.exe` |
| `DEVMIND_TOOL_TIMEOUT_MS` | `30000` | Non-streaming tool-call timeout in milliseconds |
| `DEVMIND_CONFIG_PATH` | *(platform default — see §3)* | Override config file location |

**PowerShell set syntax**:
```powershell
$env:DEVMIND_MCP_SERVER_PATH = "C:/path/to/DevMind.McpServer.exe"
$env:DEVMIND_BASE_URL = "http://10.0.0.15:8080/v1"
```

---

## 3. Configuration File

### Locations (platform-correct)

| Platform | Default path |
|----------|-------------|
| Windows | `%APPDATA%\devmind\shell.json` → `C:\Users\<user>\AppData\Roaming\devmind\shell.json` |
| macOS | `~/Library/Application Support/devmind/shell.json` |
| Linux | `$XDG_CONFIG_HOME/devmind/shell.json` or `~/.config/devmind/shell.json` |

Override with `DEVMIND_CONFIG_PATH=<absolute-path>`.

### Schema

All fields optional. Env vars override config file values.

```json
{
  "baseURL":       "http://10.0.0.15:8080/v1",
  "apiKey":        "lm-studio",
  "model":         "<model-id>",
  "mcpServerPath": "C:/path/to/DevMind.McpServer.exe",
  "toolTimeoutMs": 30000
}
```

| Field | Type | Env var override |
|-------|------|-----------------|
| `baseURL` | string | `DEVMIND_BASE_URL` |
| `apiKey` | string | `DEVMIND_API_KEY` |
| `model` | string | `DEVMIND_MODEL` |
| `mcpServerPath` | string | `DEVMIND_MCP_SERVER_PATH` |
| `toolTimeoutMs` | number | `DEVMIND_TOOL_TIMEOUT_MS` |

---

## 4. McpServer Path Resolution

Four-tier chain, evaluated in order. First hit wins.

| Tier | Source | Path / Condition |
|------|--------|-----------------|
| 1 | Env var | `DEVMIND_MCP_SERVER_PATH` |
| 2 | Config file | `mcpServerPath` field |
| 3a | Adjacent sibling (Release) | `../DevMind/DevMind.McpServer/bin/Release/net8.0/DevMind.McpServer.exe` |
| 3b | Adjacent sibling (Debug) | `../DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe` |
| 4 | Hard error | Startup aborts; entire tried chain printed to stderr; exit 1 |

**Assumes**: DevMind and DevMindShell repos are cloned as siblings (`../DevMind/`).

**Subprocess working directory**: passed as the cwd when Bun spawns the McpServer process. Path is converted to forward-slash convention via `toSubprocessPath()` (`src/util/path.ts`).

---

## 5. Project Context Loading (DevMind.md / CLAUDE.md / AGENTS.md)

Scanned on startup from the shell's cwd. Injected into the LLM system prompt.

### Discovery order (precedence)

1. `DevMind.md` — primary, project-native
2. `CLAUDE.md` — Claude Code compatibility
3. `AGENTS.md` — GitHub Copilot compatibility

### Rules

- First file found → **primary** context block.
- Subsequent files found → **supplementary** context blocks, each wrapped separately.
- Per-file size cap: **32 KB**. Files exceeding the cap are truncated with a marker.
- If no file is found, system prompt contains no project context block.
- Source: `src/util/projectContext.ts` — `CANDIDATES = ["DevMind.md", "CLAUDE.md", "AGENTS.md"]`.

---

## 6. Available Tools

Exposed by `DevMind.McpServer.exe` (v4.2). All tool calls are dispatched sequentially via a Channel-based FIFO queue — no parallel dispatch.

### Read-only tools

| Tool | Required params | Optional params | Cap / Notes |
|------|-----------------|-----------------|-------------|
| `list_memory_topics` | *(none)* | — | Lists all saved memory topics |
| `read_file` | `filename` | `start_line`, `end_line`, `force_full` | Files ≥100 lines return outline by default; `force_full=true` bypasses. Git: pass `"git log"` or `"git diff [args]"` as filename |
| `list_files` | `glob` | `recursive` (default `true`) | Cap: 200 results. Skips bin/obj/.vs/.git/node_modules |
| `grep_file` | `pattern`, `filename` | `start_line`, `end_line` | Cap: 50 matches. Case-insensitive substring, not regex |
| `find_in_files` | `pattern`, `glob` | `start_line`, `end_line` | Cap: 100 matches across all files. Case-insensitive substring |
| `diff_file` | `filename` | — | Unified diff vs. session snapshot (first read_file/patch_file). Returns `"no changes"` if no mutations this session |
| `recall_memory` | `topic` | — | Returns saved topic content; suggests available topics on miss |

### Mutation tools

| Tool | Required params | Optional params | Notes |
|------|-----------------|-----------------|-------|
| `patch_file` | `filename`, `find`, `replace` | — | Whitespace-normalized match. Returns fuzzy-match badge if confidence < Exact. Backup in `%TEMP%\DevMind\McpServer\` |
| `create_file` | `filename`, `content` | — | Fails if file exists. Creates parent directories. |
| `append_file` | `filename`, `content` | — | Creates file if missing. Ensures newline separator before appended content. |
| `delete_file` | `filename` | — | Snapshots before delete (for diff_file history). |
| `rename_file` | `old_filename`, `new_filename` | — | Fails if destination exists. Does not update references. |
| `save_memory` | `topic`, `content` | `description` | Overwrites existing topic. Slug is sanitized. |

### Streaming tools

Progress notifications are streamed line-by-line to the shell during execution. The shell's queue+signal pump renders them inline as they arrive.

| Tool | Required params | Optional params | Notes |
|------|-----------------|-----------------|-------|
| `run_shell` | `command` | — | PowerShell, 120s hard timeout. PATH may lack System32 in McpServer subprocess — use builtin cmdlets or full paths |
| `run_build` | *(none)* | — | Auto-detects build command: `.vsixmanifest` → MSBuild; else `dotnet build` against first `.sln`/`.slnx` |
| `run_tests` | — | `project`, `filter` | `dotnet test`. Omit `project` to run all tests in working dir |

### Virtual tool (shell-side only)

| Tool | Notes |
|------|-------|
| `task_done` | Registered in the OpenAI tools array; never dispatched to McpServer. Emitted by the model to signal task completion. Terminates the agentic loop. |

---

## 7. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Shift+Enter` | Insert newline in input (multi-line prompts) |
| `Esc` | Cancel in-flight LLM stream or tool dispatch |
| `Ctrl+C` | Graceful exit: abort active work → disconnect McpServer → exit 0. Second Ctrl+C → force exit 130 |

---

## 8. Status Bar States

Rendered as the bottom line of the Ink UI (`<StatusBar>` component, `src/index.tsx`).

| Display | Meaning |
|---------|---------|
| `○ Ready` | Idle; waiting for input |
| `● Thinking…` | LLM streaming tokens |
| `● Tool: <name>` | MCP tool call in progress |
| `[Cancelled]` | Esc pressed; stream or tool aborted |
| `[Error]` | Unrecoverable error in current turn |

Colors: `○` uses `dim` (`#888888`); `●` uses `pending` (`#DCDCAA`); `[Cancelled]` and `[Error]` use `error` (`#F44747`). See §10 for full palette.

---

## 9. Timeouts and Limits

### Timeouts

| Item | Default | Override | Notes |
|------|---------|----------|-------|
| Non-streaming tool calls | 30,000 ms | `DEVMIND_TOOL_TIMEOUT_MS` | Applies to all tools except run_shell/run_build/run_tests |
| Streaming tool calls | 600,000 ms (10 min) | *(hardcoded)* | `resetTimeoutOnProgress: true` — each output line resets the clock |
| llama-server startup probe | 3,000 ms | *(hardcoded)* | WARN on failure; not fatal. Shell continues. |
| run_shell / ShellRunner | 120,000 ms | *(McpServer-side hardcoded)* | Process tree killed via `taskkill /F /T` on timeout |
| SDK kill sequence | ≤4,000 ms | *(SDK)* | stdin EOF → 2s grace → SIGTERM → 2s grace → SIGKILL |

### Agentic loop limits

| Limit | Value | Description |
|-------|-------|-------------|
| `DEPTH_CAP` | 10 | Max tool-dispatch rounds per user turn. Terminates with error message if exceeded. |
| Crash recovery | 1 retry | McpServer crash → auto-reconnect → retry tool once → abort turn on second crash |

### Context budget

| Threshold | Action | Target after trim |
|-----------|--------|------------------|
| 80% of ceiling | Soft trim: drop oldest 2 turn pairs with `[DROPPED]` summaries | 70% |
| 95% of ceiling | Hard trim: drop oldest 4 turn pairs without summaries | 60% |

- Context ceiling: **131,072 tokens** (configurable in `contextBudget.ts`).
- System message is always pinned at index 0 — never dropped.
- Tool-call + tool-result pairs drop atomically — no orphaned `tool_call_id` references.
- Token estimate: chars ÷ 4 (approximation; `estimateTokens()` in `src/loop/contextBudget.ts`).

### Tool result caps

| Tool | Cap |
|------|-----|
| `list_files` | 200 results |
| `grep_file` | 50 matches |
| `find_in_files` | 100 matches |
| `read_file` (outline threshold) | 100 lines (files below → full content) |
| Project context per file | 32 KB |

---

## 10. Color Theming

Source: `src/ui/theme.ts`. Hex values match the DevMind WPF VSIX palette.

| Token | Hex | Usage |
|-------|-----|-------|
| `normal` | `#CCCCCC` | Default text, LLM response content |
| `dim` | `#888888` | Status bar (idle), banners, inactive borders |
| `input` | `#569CD6` | User prompt indicator, banner title, active borders, tool result delimiters |
| `error` | `#F44747` | Errors, cancellations, stderr output |
| `success` | `#4EC94E` | Task done marker, successful tool results |
| `thinking` | `#6A6A8A` | `reasoning_content` / chain-of-thought blocks |
| `pending` | `#DCDCAA` | In-flight indicators (active tool calls, generating) |

Ink renders hex via ANSI Truecolor. Terminals without Truecolor support fall back to the nearest 256-color or 16-color equivalent.

---

## 11. Logs and Diagnostics

### Startup error output

Three failure paths print a formatted block to stderr before Ink initializes:

| Failure | Behavior | Exit code |
|---------|----------|-----------|
| `resolveConfig()` throws | Error block printed; process exits | 2 |
| llama-server probe fails | WARN block printed; startup continues | *(none — non-fatal)* |
| McpServer `connect()` fails | Error block with remediation hint; process exits | 1 |

### McpServer stderr

All McpServer diagnostics go to its own process stderr. Never mixed with MCP JSON-RPC frames on stdout. Visible in the terminal that launched the shell (stderr passthrough from the subprocess).

### Diagnostic scripts

| Script | Purpose |
|--------|---------|
| `scripts/config-test.ts` | Validates all 5 path-resolution tiers; prints PASS/FAIL per tier |
| `scripts/shutdown-test.ts` | Verifies McpServer subprocess teardown latency and lifecycle step registration |
| `scripts/budget-test.ts` | Exercises all 4 context-trim cases; prints before/after token counts |
| `scripts/timeout-test.ts` | Measures kill-to-throw latency for McpError -32001 |
| `scripts/cycle-test.ts` | End-to-end read → patch → run cycle test; prints 5 "Done when" criteria |
| `scripts/sse-gate.ts` | Raw SSE streaming verification against the llama-server endpoint |

Run any script: `bun run scripts/<name>.ts`

---

## 12. Common Errors and Resolutions

| Error | Cause | Resolution |
|-------|-------|-----------|
| `McpError: MCP error -32000: Connection closed` | McpServer process crashed or was killed | Auto-reconnect + one retry is attempted. If it recurs, check McpServer stderr for the crash reason. |
| `McpError: MCP error -32001: Request timed out` | Tool call exceeded `DEVMIND_TOOL_TIMEOUT_MS` (30s default for non-streaming) | Increase `DEVMIND_TOOL_TIMEOUT_MS` for slow tools, or switch to a streaming tool (`run_shell`/`run_build`). |
| `[startup] McpServer not found — tried:` + path list | McpServer.exe not at any of the 4 resolution tiers | Set `DEVMIND_MCP_SERVER_PATH` to the absolute path of the built exe, or build DevMind in the sibling repo. |
| `[startup] llama-server probe failed` (WARN, non-fatal) | `GET /v1/models` to `DEVMIND_BASE_URL` timed out or returned an error | Verify llama-server is running. Shell continues — model calls will fail until it is reachable. |
| `[startup] Configuration error` → exit 2 | `resolveConfig()` threw; likely malformed JSON in the config file | Validate the config file at the platform path (§3) with a JSON linter. |
| `patch_file: failed — find text not found or is ambiguous` | FIND text doesn't match file content exactly (or matches multiple locations) | Call `read_file` on the target file first, copy the exact text, then retry `patch_file`. |
| `patch_file: file already exists — use patch_file to edit it` | `create_file` called on an existing file | Use `patch_file` for edits; `create_file` is for new files only. |
| `rename_file: destination already exists` | Target filename already on disk | Delete the destination first or choose a different name. |
| `[list_files error]: glob pattern is empty` | `glob` param was empty string | Always pass a non-empty glob (e.g., `"*.cs"`, `"**/*.ts"`). |
| Streaming output appears only at end of tool call | Progress queue not draining (Phase C issue — fixed in `AgenticLoop.ts`) | Should not recur. If observed, check `PROGRESS_TOOLS` set in `src/loop/AgenticLoop.ts`. |
| `bun run dev` exits immediately with no output | Ink initialization failure (typically a missing peer dependency) | Run `bun install`; verify `yoga-layout` (not `yoga-layout-prebuilt`) is present in `node_modules`. |
| `powershell.exe` not found inside `run_shell` | McpServer subprocess PATH lacks System32 | Use PowerShell builtin cmdlets (e.g., `Get-Content`, `Start-Sleep`) or provide the full path (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`). |
| TypeScript error on `FinishReason` type | Complex conditional type resolving to `never` (Phase C — fixed) | Ensure `AgenticLoop.ts` uses the explicit `type FinishReason = "stop" \| "length" \| "tool_calls" \| ...` union, not the conditional inference form. |
