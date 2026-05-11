---
doc_type: phase_summary
project: DevMindShell
stage: 11
phase: A
title: Stage 11 Phase A Summary
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
status: complete
rag_ready: true
---

# Stage 11 Phase A — Summary

**Outcome**: All three Phase A goals met. Bun is the confirmed runtime. The repo is positioned for Phase B (streaming UX + token rendering).

## Sequencing chosen

**Gate first.** Reasoning: the openai-npm-on-Bun question was the highest-uncertainty item in the discovery doc. Verifying it in isolation took ~5 minutes; if it had failed, I'd have stopped scaffolding and switched to Node 20+ before sinking effort into project structure. Doing it inside the project structure first would have meant tearing down the project structure after a failure. Gate-first is strictly cheaper.

The cost paid was minor: one throwaway script in `/c/temp/bun-ink-spike` (the gate test from the prior spike directory was extended), then the same script promoted into `scripts/sse-gate.ts` once the gate passed. The script remains in the repo as the canonical revalidation test (re-run via `bun run gate`).

## Location chosen

**Existing `C:/Users/pkailas/source/repos/DevMindShell` repo, adopted and adapted.** The directory already held a partial Phase A scaffold from a prior session (Node + tsx-based, no `openai` package, McpClient existed). Adopt + adapt was strictly preferable to discarding because:

- The McpClient wrapper was reasonable and worked under Bun unchanged
- Existing git history with a coherent commit was already in place
- Restarting from scratch would have wasted that work and added a non-zero chance of subtle regressions (missing imports, wrong tsconfig, etc.)

Changes made: switched runtime from Node+tsx to Bun-first (kept tsx as a Node-fallback devDep), added `openai` npm, added forward-slash path utility, restructured `src/` into `mcp/`, `llm/`, `util/` subfolders, added `scripts/`, added README frontmatter.

The repo is currently local-only. Push to the Synology NAS Git host is deferred — a no-cost step the user can perform when ready.

## Gate result: PASS

**Bun 1.3.13 + openai 6.36.0 + ik_llama.cpp at http://127.0.0.1:1234/v1 streams correctly.**

Verbatim evidence from `scripts/sse-gate-evidence.txt` (re-runnable via `bun run gate`):

```
=== Phase A SSE gate test ===
Date: 2026-05-06T11:48:33.855Z
Bun: 1.3.13
baseURL: http://127.0.0.1:1234/v1
model: G:\models\GEMMA4\google_gemma-4-31B-it-Q8_0.gguf
prompt: "Say hi" with max_tokens=80

[+201ms] stream opened, awaiting first delta...
[+203ms] delta #1: content="" reasoning=""
[+289ms] delta #2: content="" reasoning="The"
[+319ms] delta #3: content="" reasoning=" user"

=== Stream complete ===
Total deltas: 39
Total elapsed: 1422ms
First delta arrived: +203ms
Last delta arrived:  +1421ms
First 9 inter-delta intervals (ms): 85, 31, 30, 30, 30, 30, 29, 30, 29

reasoning_content (Gemma 4 CoT, 83 chars):
The user said "Say hi".
The user wants a greeting.
"Hi!" or "Hello!" or "Hi there!"

content (35 chars, first appeared at +1123ms):
Hi there! How can I help you today?

VERDICT: PASS
  - incremental delivery: YES  (39 deltas spanning 1218ms)
  - output produced: YES
```

The pass criteria from `scripts/sse-gate.ts` are met: 39 deltas spanning 1218ms (clearly incremental), inter-delta intervals consistent at ~30ms, both fields populated.

## What works

| Phase A goal | Verified | How |
|---|---|---|
| 1. SSE gate (openai npm streams under Bun) | ✓ | `bun run gate` — see evidence above |
| 2. Minimum viable shell (Ink + input + non-streaming completion) | ✓ | `bun run dev -- --prompt "What is 2 plus 2?"` produced "Two plus two equals four." with prompt=30/completion=114 tokens |
| 3. MCP client connects to McpServer | ✓ | `bun run smoke` produced "[MCP] 16 tools available" + successful list_memory_topics call + clean disconnect |

Subsystems independently verified, each via its own runnable. No cross-coupling between them in Phase A — that arrives in Phase C when tool dispatch enters the agentic loop.

## What broke

Nothing operationally broke. Two findings worth recording:

### Finding 1: ik_llama.cpp emits Gemma 4 chain-of-thought in `delta.reasoning_content`, not `delta.content`

Discovered while diagnosing why the first gate test (max_tokens=10) had `assembledText.length === 0` despite seeing 100 token-bearing deltas.

Verbatim raw SSE bytes from `curl -N` against `/v1/chat/completions` (max_tokens=10, prompt "Say hi"):

```
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1778067689,"id":"chatcmpl-sJdhRctq6h3kcoyEKG1MEiWpE9FiWmad","model":"x","object":"chat.completion.chunk","usage":{"completion_tokens":1,"prompt_tokens":18,"total_tokens":19}}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"The"}}],"created":1778067689,"id":"chatcmpl-sJdhRctq6h3kcoyEKG1MEiWpE9FiWmad","model":"x","object":"chat.completion.chunk","usage":{"completion_tokens":4,"prompt_tokens":18,"total_tokens":22}}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" user"}}],"created":1778067689,"id":"chatcmpl-sJdhRctq6h3kcoyEKG1MEiWpE9FiWmad","model":"x","object":"chat.completion.chunk","usage":{"completion_tokens":5,"prompt_tokens":18,"total_tokens":23}}

[...continued with reasoning_content... then once reasoning ends:]

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"Hi"}}],"created":1778067715,"id":"chatcmpl-J3RUmgsxznzUUutbkr91Yxr3hWtKxIr9","model":"x","object":"chat.completion.chunk","usage":{"completion_tokens":32,"prompt_tokens":18,"total_tokens":50}}
```

Implications:
- The shell must extract both `delta.content` AND `delta.reasoning_content` from each chunk. The `CompletionClient` in `src/llm/CompletionClient.ts` does this.
- With small `max_tokens` (e.g. 10), the model spends them all reasoning and never emits visible content. Default `max_tokens` of 512 is enough for short responses.
- The reasoning content is genuinely useful UX — surfacing it (collapsed/dimmed by default) gives the user visibility into model thinking. Phase B/C UX should consider this.
- This finding extends Stage11-Tech-Reference.md §5 ("Token usage accounting in streaming — present but accuracy vs OpenAI not compared") with a more substantive ik_llama.cpp-specific quirk. Will append to the tech reference in a follow-up commit.

### Finding 2: ik_llama.cpp emits usage info in every chunk, not just the final chunk

Real OpenAI sends a single usage chunk at the end when `stream_options.include_usage: true`. ik_llama.cpp emits an updated usage object on every chunk. Not blocking, just different — the shell should ignore intermediate usage values and use the final one. The openai npm package surfaces this as `chunk.usage` so the shell sees it; ignoring all but the last is straightforward.

## Phase B prerequisites

Nothing blocking. Phase B can start immediately. Items to keep in mind:

- **Streaming UX**: replace the non-streaming `CompletionClient.complete()` with a streaming variant. The async-iterable interface (`for await (const chunk of stream)`) is what the gate test uses; same pattern fits the shell. Render tokens into a live `<ActiveTurn>` component as they arrive. Use `<Static>` for completed turns per discovery doc §5.
- **Stop/Cancel during streaming**: discovery doc §9.1 flagged this as a Phase B verification item. Test that `useInput()` Escape handling fires reliably while SSE tokens arrive at ~30ms cadence. Mitigation path (signal-based cancellation via `process.on('SIGINT')`) is well-understood.
- **Reasoning vs content rendering**: Phase B should decide UX for the reasoning_content field. Recommended: dimmed `[thinking]` block above the response, optionally collapsible.
- **Static + high-frequency render isolation**: discovery doc §9.5. Verify `<Static>` doesn't redraw under 30ms-cadence updates.

## Open questions raised

- **Phase D config layering**: For Phase A I used `DEVMIND_BASE_URL` / `DEVMIND_API_KEY` / `DEVMIND_MODEL` env vars with defaults. Phase D needs the full resolution chain (env → config file → defaults). The names are tentative — the user may prefer `OPENAI_BASE_URL` (matches openai npm conventions) or something else. Surface this in Phase D design.
- **Reasoning_content surfacing in tool-call mode**: When the model is choosing tools (Phase C), does Gemma 4 use reasoning_content for its tool-selection deliberation? This affects whether reasoning_content needs to be rendered alongside tool calls or hidden during them. Worth confirming in Phase C with a few empirical probes.
- **McpServer path resolution in Phase A**: The smoke test hardcodes `C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe`. This is fine for Phase A but will need the discovery-doc §7 path-resolution chain in Phase D. Not blocking but worth recording.

## Commits

```
d0091b2  phase A: SSE gate pass
5460e81  phase A: scaffold DevMindShell
22876fb  phase A: MCP client connects to McpServer
<this>   docs: Stage 11 Phase A summary
```

Plus a separate commit in the DevMind repo appending the reasoning_content finding to Stage11-Tech-Reference.md §5.
