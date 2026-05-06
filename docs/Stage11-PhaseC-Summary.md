---
doc_type: phase_summary
project: DevMindShell
stage: 11
phase: C
title: Stage 11 Phase C Summary
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

# Stage 11 Phase C — Summary

**Outcome**: Phase C done. The read → patch → run agentic cycle works end-to-end against real tools. McpServer crash recovery verified. Parallel tool calls observed not to occur in 9 rounds. The shell can now be asked to do real work (read, search, patch, build, run shell) and the model drives it through completion.

## Sequencing chosen

Default order from the prompt:

1. Agentic loop against `read_file` (the architectural core)
2. `<ToolCallView>` + `<ToolOutputRegion>` UI
3. §9.3 crash recovery verification
4. Streaming-tool progress verification
5. §9.4 parallel observation (piggybacked on the cycle test)
6. read → patch → run cycle (the §8 "Done when" criterion)

The prompt's commit order put the cycle test as a separate commit after §9.4. I bundled them — the cycle test is naturally the place to observe parallel calls because it triggers varied tool selections. Splitting would have required two test runs against the same target. Documented in the commit message.

## Architectural decisions made

### Tool-call accumulation pattern

Streaming tool_calls from openai npm 6.36.0 fragment across deltas. Cited from `node_modules/openai/resources/chat/completions/completions.d.ts:512`:

```ts
interface ToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  type?: 'function';
}
```

`StreamingClient.stream()` accumulates per-`index`:
- `id` arrives once early
- `function.name` accumulates (rare to fragment, but the type allows it)
- `function.arguments` is a JSON-string fragment that concatenates across deltas
- `finish_reason: "tool_calls"` (cited from `completions.d.ts:460`) signals end of accumulation

JSON.parse of `arguments` runs at dispatch time, not during accumulation. The model can emit malformed JSON (the openai npm comment at `completions.d.ts:503` explicitly warns about this). Parse failures synthesize an error tool result with `_parse_error` + `_raw` fields and surface to the model as a regular tool result so it can re-try.

### Multi-turn history shape

A single `ChatCompletionMessageParam[]` lives in the AgenticLoop instance. Every turn appends to it:

- User message: `{ role: "user", content }`
- Assistant message per round: `{ role: "assistant", content?, tool_calls? }` — content is the text response; tool_calls is populated when the round ends with `finish_reason: "tool_calls"`
- Tool result message per call: `{ role: "tool", tool_call_id, content }`

Order is strict: assistant message containing `tool_calls` must immediately precede the matching `role: "tool"` messages. OpenAI's API requires every `tool_call_id` referenced in an assistant message to receive a tool message back; the loop synthesizes one even for `task_done` (which is virtual) so the history stays well-formed.

`reasoning_content` is **stripped from history** before re-feeding. Reasoning is a UX artifact — re-feeding it would multiply token consumption without quality gain. Per Phase C prompt + decision logged in `src/loop/AgenticLoop.ts` header.

### Crash recovery approach

Sync-throw + reconnect + retry. Verified by §9.3 — see verification section.

The `McpClient.reconnect()` method tears down the current `Client` (best-effort `close()` then nullify) and runs `connect()` again with the originally-stored serverPath/workingDir. AgenticLoop's per-call try/catch catches `McpError`, calls `reconnect()`, retries the call once. If reconnect or retry fails, the loop emits `turn_complete{reason: "error"}` with a clear message — no retry loop, no tarpit.

### `<ToolCallView>` summarization

Args truncated at 80 chars (display only — the model sees full args). Result first non-empty line truncated at 100 chars with `(+N more lines)` suffix. Yellow header during dispatch, green/red on completion. The full `result` text stays in the messages array for the model.

### `<ToolOutputRegion>` for streaming tools

`run_shell` / `run_build` / `run_tests` only. Each progress line goes into a `useState` array via `tool_call_progress` events. Latest 12 lines visible; older lines collapse to `… N earlier line(s) omitted`. Once the call completes, the region disappears and the result summary takes its place. This matches the discovery doc §5 sketch.

The technical bit: the SDK's `onprogress` callback fires *synchronously* during `await callTool()`, but the AgenticLoop's async generator can't yield from inside that callback (different async context). The fix: a queue + signal pump in the generator that drains queued lines before/while awaiting the call promise. Without this, progress lines would batch at the end of the call — defeating the purpose of streaming. Logged in `src/loop/AgenticLoop.ts` and tested in `scripts/progress-smoke.ts`.

## §9.3 verification — McpServer crash recovery

**Time spent: ~12 minutes (under 30-min cap).**

**Verdict: PASS — sync-throw with clean reconnect + retry.**

Test: `scripts/crash-test.ts`. Method: connect → start a 5s blocking PowerShell `Start-Sleep` call → `taskkill /F /PID <McpServer pid>` at +500ms → observe.

**Verbatim error from `scripts/crash-test-evidence.txt`:**

```
callTool threw: McpError
  message: MCP error -32000: Connection closed
  McpError: MCP error -32000: Connection closed
      at fromError (...sdk/dist/esm/types.js:2048:20)
      at _onclose (...sdk/dist/esm/shared/protocol.js:263:32)
      at <anonymous> (...sdk/dist/esm/shared/protocol.js:223:18)
      at <anonymous> (...sdk/dist/esm/client/stdio.js:85:22)
```

**Behavior class**: `sync-throw` (one of the three discovery doc §9.3 possibilities). The SDK throws an `McpError` with code `-32000` from the awaited `callTool()` promise. Catchable in normal try/catch.

**Reconnect**: succeeded — fresh McpServer subprocess spawned, initialize handshake completed.

**Retry**: succeeded — `list_memory_topics` returned cleanly.

**One observation worth flagging**: time from `taskkill` to the `McpError` throw was ~4.5s. Slower than I'd have guessed — the SDK appears to wait for stdio EOF/error rather than detecting process death directly. Not a hang (silent-drop would be infinite). Acceptable for Phase C; Phase D could add a request-level timeout to shorten this if needed.

## §9.4 verification — parallel tool calls

**Time spent: bundled into the cycle test (~5 min total).**

**Verdict: NOT OBSERVED in 9 rounds across 2 varied turns.**

Test: `scripts/cycle-test.ts`. Two turns:
- Turn 1 (read → patch → run cycle): 6 rounds
- Turn 2 (multi-action listing/reading): 3 rounds

Every single round that ended with `finish_reason: "tool_calls"` emitted exactly **one** tool call in its `tool_calls` array. Verbatim from `scripts/cycle-test-evidence.txt`:

```
§9.4 Parallel tool calls observed?
  NOT OBSERVED in any round across 2 turns / 9 rounds.
  Each tool_calls round emitted exactly one tool call.
```

The Gemma 4 + ik_llama.cpp combination chains tool calls *across rounds* rather than batching them in a single round. Even when explicitly asked to do multiple things in one turn ("list all files... then read greet.ps1... then call task_done"), the model used one tool per round.

Confidence on the discovery doc §9.4 claim ("Gemma 4 does not emit parallel tool calls against ik_llama.cpp") moves from LOW to MEDIUM — observational, not exhaustive. The sequential-dispatch implementation is correct regardless of how this confidence shakes out, because:
- `Promise.all` is never used
- Each tool dispatch awaits before the next
- If parallel calls were observed in some future scenario, dispatching them sequentially is still correct (just slower than ideal)

## Reasoning_content during tool-selection rounds

**Phase B carried this forward as an open question. Verdict: reasoning_content DOES appear during tool-selection rounds.**

Across the 9 rounds in the cycle test, reasoning chars per round were: `242, 94, 108, 0, 589, 0, 335, 0, 246`. Six of the nine rounds had reasoning. Three had zero — those tended to be straightforward follow-up rounds where the next action was obvious from the previous result.

UX implication: the existing `<ReasoningBlock>` from Phase B works correctly. It renders only when there's text. No special tool-selection-mode handling needed.

The reasoning content during tool-selection rounds is genuinely informative — the model deliberates "the user wants X; based on the file contents I should patch Y..." style chains. Surfacing this dimmed during the active turn (collapsed once the turn moves into `<Static>`) provides good visibility into model decision-making.

## Self-recovery moment worth noting

During the cycle test, round 4 dispatched `run_shell { command: "powershell -File C:\\temp\\devmind-cycle\\greet.ps1" }`. McpServer's `run_shell` couldn't resolve `powershell` (PATH issue inside its PowerShell subprocess context, also seen during the §9.3 test development). Output streamed via `tool_call_progress`:

```
+ FullyQualifiedErrorId : CommandNotFoundException
At line:1 char:1
powershell : The term 'powershell' is not recognized as the name of a cmdlet...
+ powershell -File C:\temp\devmind-cycle\greet.ps1
+ ~~~~~~~~~~
```

Round 5 dispatched `run_shell { command: "C:\\temp\\devmind-cycle\\greet.ps1" }` — direct execution, no `powershell` prefix — and succeeded with output `hello, world!`.

Real agentic feedback loop: model saw the failure, adjusted, succeeded. The shell didn't need to do anything special — feeding the streamed error back into the model's context was enough.

This is also a Phase D / Phase E observation: McpServer's `run_shell` PATH resolution is broken in some environment-dependent way. Tracked in the test script comment and the §9.3 commit message; not blocking for Phase C.

## What works

| Phase C "Done when" criterion | Verified | How |
|---|---|---|
| Read → patch → build cycle works end-to-end | ✓ | `scripts/cycle-test.ts` ran the full sequence; greet.ps1 patched on disk and re-execution confirmed |
| `run_build` streaming output visible | ✓ | `scripts/progress-smoke.ts` shows 5 lines arriving at ~1s intervals (1004, 1011, 1012, 1012ms inter-line); same path used in cycle test for run_shell |
| Tool calls dispatched correctly with results fed back | ✓ | 9 rounds across 2 turns, every result fed back into history |
| McpServer crash recovery | ✓ | §9.3 sync-throw → reconnect → retry, all green |

## Phase D prerequisites

Nothing blocking. Phase D can start.

Items to keep in mind:

- **McpServer PATH inside run_shell**: the tool's PowerShell context can't resolve `powershell.exe` / `ping.exe` / etc. (anything in System32 that requires PATH lookup). Builtin cmdlets work. The model self-recovered in the cycle test, but this is an annoying capability gap. Worth filing against McpServer for a future polish pass — set the subprocess `Environment["PATH"]` explicitly to include System32 before launching.
- **§9.3 reconnect latency**: ~4.5s from `taskkill` to `McpError` throw. Phase D could add a request-level timeout (the SDK supports it via `RequestOptions.timeout`) to shorten this when an obvious crash happens. Tradeoff: timeout-driven false positives on legitimately long tool calls. Defer to Phase D when context budget management also lands.
- **Context-budget management**: not in Phase C. The history grows unbounded across turns. After ~8-10 turns of substantial work, the 131K context will start to feel it. Phase D's rolling-window-trim (per discovery doc §6) is the right fix.
- **Path resolution chain for McpServer.exe**: still hardcoded as `C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/...`. Phase D handles env var → config → adjacent build → PATH per discovery doc §7.
- **Config file layering**: Phase D scope.

## Open questions raised

- **Tool selection between identical-looking tools**: The model picked `list_files{glob:"greet.ps1"}` first to check if the file existed before reading. That's smart, but it's a conservative pattern that could be wasteful if the model always probes paths. Worth observing whether this is repeatable behavior or a one-off. If consistent, the system prompt could be tweaked to skip the discovery probe when the user names a specific file.
- **`run_shell` failure handling expectations**: When `run_shell` returns an error result (e.g., the `powershell : not recognized` case), should the loop *retry* automatically, or always defer to the model's judgment? Current behavior: defer to model — feed the error back, let the model decide. The cycle test showed this works. But for Phase D / E "production hardening", explicit retries on certain known patterns might be useful.
- **Parallel tool calls in other scenarios**: §9.4 was tested across 2 turns. If a different prompt shape (e.g., "read files A, B, and C and summarize each") triggers parallel calls in some future test, the sequential-dispatch fallback works but the UX in the `<ToolCallView>` would show the calls one-by-one rather than concurrently. Acceptable for Phase C; user-facing feedback during long multi-tool waits could be improved.
- **Long reasoning content during tool selection**: Some rounds had 589 reasoning chars before a single tool call. The `<ReasoningBlock>` collapsed-once-in-Static UX from Phase B handles this well, but if the model is being asked complex multi-step questions, accumulated reasoning across rounds in `<Static>` could clutter the scrollback even when collapsed. Phase D's "reasoning hidden by default" toggle becomes more valuable.

## Commits

```
02282b8  phase C: agentic loop against read_file
500fb85  phase C: <ToolCallView> + <ToolOutputRegion> inline indicators
18f3cc8  phase C: §9.3 crash recovery sync-throw with reconnect
03f23a5  phase C: <ToolOutputRegion> progress streaming verified
c9178b1  phase C: read → patch → run cycle verified + §9.4 observed
<this>   docs: Stage 11 Phase C summary
```

Five work commits + this summary. The prompt's suggested commit list had `phase C: §9.4 parallel tool call observation` and `phase C: read → patch → build cycle verified` as separate commits; bundled because the cycle test naturally generates the §9.4 evidence and splitting would have been duplicative work for no narrative benefit.

Tag `phase-c` will be applied to this commit. Push to GitHub when complete; NAS push remains the user's terminal task (SSH agent constraint same as Phases A and B).
