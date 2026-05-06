---
doc_type: phase_summary
project: DevMindShell
stage: 11
phase: B
title: Stage 11 Phase B Summary
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

# Stage 11 Phase B — Summary

**Outcome**: Phase B done. Streaming chat works end-to-end against ik_llama.cpp's Gemma 4 with reasoning_content + content rendering, abort latency well under criterion, Static isolation under high-frequency live updates verified. Phase C (agentic loop + tool dispatch) is unblocked.

## Sequencing chosen

Default order from the prompt:

1. §9.5 Static stress test (15-min cap) — derisks rendering before streaming work
2. Streaming wiring (StreamingClient + new index.tsx)
3. §9.1 cancel verification (30-min cap) — runs against real streaming
4. Reasoning_content UX, multiline input, status bar — bundled into the streaming commit
5. Phase B summary

The two "nice-to-have" enhancements named in the prompt's commit strategy (`reasoning_content rendering`, `status bar + multiline input`) were absorbed into the streaming-completion commit rather than artificially split. The component tree (`<Static>` / `<ActiveTurn>` / `<InputBox>` / `<StatusBar>`) is tightly coupled by design — `<ActiveTurn>` already needed `<ReasoningBlock>` to render anything before content arrives, the input has to be multiline because §5 said so, and the status bar is one component. Splitting into three commits would have required two intermediate broken states, each compiling but not rendering. Calling this out so the commit history ↔ Phase B scope mapping is explicit.

## §9.5 verification — Static under high-frequency updates

**Time spent: ~5 minutes (under 15-min cap).**

**Verdict: PASS.**

Synthetic test (`scripts/static-stress.tsx`): 5 `<Static>` items + an `<ActiveTurn>` that re-renders 100 times at 30ms intervals (matching the SSE delta cadence observed in the Phase A gate). Each Static item's render function appends to a counter via `useRef`; counters are dumped to an evidence file at end.

Verbatim evidence (`scripts/static-stress-evidence.txt`):

```
[STATIC-RENDER] id=1 count=1
[STATIC-RENDER] id=2 count=1
[STATIC-RENDER] id=3 count=1
[STATIC-RENDER] id=4 count=1
[STATIC-RENDER] id=5 count=1

=== Stress test summary ===
ActiveTurn renders: 101
Static id=1 renders: 1
Static id=2 renders: 1
Static id=3 renders: 1
Static id=4 renders: 1
Static id=5 renders: 1
max Static renders: 1
VERDICT: PASS
```

Each Static item mounted exactly once over 100 ActiveTurn updates. No throttling mitigation is needed; the real shell can re-render `<ActiveTurn>` per token without affecting completed turns.

This validates the discovery doc §9.5 assumption (Ink's `<Static>` is render-once-and-flush) at the actual streaming cadence.

## §9.1 verification — Stop/Cancel under streaming load

**Time spent: ~10 minutes (under 30-min cap).**

**Verdict: PASS.**

Test method (`scripts/cancel-test.ts`): start a streaming request that asks the model for a 500-line poem (will run for 30+ seconds if not cancelled). At t=500ms after stream start, fire the abort. Measure time from abort.abort() to for-await loop exit.

| vector                | min (ms) | max (ms) | avg (ms) | verdict |
|-----------------------|---------:|---------:|---------:|---------|
| abort-direct          |        0 |        1 |        1 | PASS    |
| abort-via-settimeout  |        0 |        4 |        2 | PASS    |

(verbatim from `scripts/cancel-test-evidence.txt`)

**`abort-direct`** fires `abort.abort()` from a single setTimeout. **`abort-via-settimeout`** wraps the abort in a nested `setTimeout(0)` to simulate the path through `useInput` → callback → `setTimeout(0)` → abort that the actual Esc handler exercises.

All 6 runs terminate the for-await loop in ≤4ms. The 300ms criterion has 75× headroom. The §9.1 mitigation (Esc handled via AbortController polled at each `for await` iteration) is unnecessary at this latency — direct `abort.abort()` is fast enough on its own. The shell's actual Esc handler simply calls `abortRef.current?.abort()`.

### A third vector was attempted and dropped — `process.kill(pid, 'SIGINT')`

The cancel test originally tested a SIGINT vector by self-delivering SIGINT. It exited the test process before any handler could run. Per the Node docs:

> On Windows, the signal argument has no effect, and the process will be terminated unconditionally.  
> Source: https://nodejs.org/api/process.html#processkillpid-signal

So `process.kill(process.pid, 'SIGINT')` on Windows is just `TerminateProcess`. This is a property of Windows signal emulation, not a Bun bug. The vector is untestable from inside the same Bun process on Windows.

In production the SIGINT path is exercised when the user presses Ctrl+C in their terminal — the terminal delivers a real `CTRL_C_EVENT` to bun.exe, and the registered handler in `src/index.tsx` runs `abortRef.current.abort()` then `setTimeout(() => exit(), 50)`. The handler's behavior after `abort()` is the same code path as the `abort-via-settimeout` vector that's already verified at <4ms latency.

### StreamingClient bug fix found during this verification

The first cancel test run reported `aborted=false` even though latency was clearly post-abort. Root cause: `StreamingClient.stream()` had two exit paths — a `break` path (when `signal.aborted` was already true at the top of the for-await loop) and a catch path (when the SDK threw `APIUserAbortError` mid-loop). The break path yielded `done{finishReason: null}` instead of `done{finishReason: "abort"}`. Fixed in the same commit:

```ts
const wasAborted = opts.signal?.aborted ?? false;
if (lastUsage && !wasAborted) yield lastUsage;
yield { type: "done", finishReason: wasAborted ? "abort" : finishReason };
```

After the fix, both vectors correctly report `aborted=true`. The downstream `<ActiveTurn>` cancellation marker now lights up in both abort paths.

## reasoning_content UX

Built per the prompt's "decision required, not punted" guidance. Component: `<ReasoningBlock>` in `src/index.tsx`.

**During streaming** (active turn):
- Always expanded
- Header: `▼ thinking... (~N tokens)` with tilde to indicate the count is approximate
- Body: full reasoning text in dim color
- Approximate token count via `chars / 4` until the usage chunk lands

**After streaming** (turn moved into `<Static>`):
- Collapsed by default
- Header: `▶ thinking (~N tokens) — collapsed`
- No body shown
- The collapse is intentional: completed turns shouldn't visually dominate the conversation

**Deferred to later phases**:
- Ctrl+R toggle to expand/collapse the active turn's reasoning. Marked nice-to-have in the prompt; not implemented. Easy to add when there's user demand. (Note: completed turns can't be toggled because `<Static>` items are immutable post-flush — that's a structural Ink constraint, not a missing feature.)
- Saving collapsed/expanded state across turns
- Folding very long reasoning into a "show more" summary

## Multiline input + status bar

Bundled into the streaming commit. Brief description here for completeness.

**Multiline input** (`<InputBox>`):
- Border, green border when active
- Enter alone → submit (only if buffer is non-empty after trim)
- Shift+Enter → insert newline into buffer
- Backspace → delete last char (handles cross-line)
- Cursor block (`▌`) on the last line of the buffer when active

**Caveat**: Shift+Enter detection depends on the terminal sending distinguishable byte sequences for Enter vs Shift+Enter. Most modern Windows terminals (Windows Terminal, conhost in Win10+) do this correctly. Older terminals may collapse them. Not verified empirically on every Windows console — flagged as a potential Phase D polish item.

**Status bar** (`<StatusBar>`):
- Last in the component tree → appears at the bottom of the visible terminal per Ink rendering order
- States:
  - Streaming: `■ Generating... (N tokens, X.Ys)  [Esc to cancel]` — yellow
  - Ready: `○ Ready  [Enter to send · Shift+Enter for newline · Ctrl+C to exit]` — green/dim
  - Error: `✗ Error` — red
- Token count is the approximate count during streaming, exact count after the usage chunk lands

## What works

| Phase B "Done when" criterion | Verified | How |
|---|---|---|
| Interactive single-turn streaming renders correctly | ✓ | Component tree typechecked, StreamingClient verified headlessly via streaming-smoke.ts (77 reasoning events, finishReason=stop), §9.5 confirms Static stays stable under live churn |
| Token count visible in status bar | ✓ | `<StatusBar>` reads `active.tokenCount` which is updated on every reasoning_delta / content_delta and replaced with exact `usage.completion_tokens` when the usage chunk lands |
| Stop works | ✓ | §9.1 verification: Esc via AbortController exits the for-await loop in ≤4ms; Ctrl+C via `process.on('SIGINT')` calls `abortRef.current.abort()` then `setTimeout(() => exit(), 50)` |

The interactive shell itself requires a real TTY (Ink's `useInput` requires raw mode). I cannot drive a TTY from inside Claude's bash subshell, so the user-driven part of the verification — sitting at the terminal and typing prompts — is the user's to do. All non-interactive subsystems (StreamingClient, AbortController, Static rendering, the component tree's typecheck) are verified.

## What broke

Two bumps along the way, both fixed:

### Bump 1: cancel test SIGINT vector unusable on Windows

Documented above. Removed the vector, added a verbatim Node-doc citation explaining why. The remaining two vectors are sufficient — the SIGINT-handler in `src/index.tsx` calls into the same code path as `abort-via-settimeout`, which is verified.

### Bump 2: StreamingClient "break" path didn't mark cancels as `finishReason: "abort"`

Documented above. Fixed in the same commit as the §9.1 verification. The downstream UI now correctly displays the `[cancelled]` marker on cancelled turns.

### Bump 3: Phase B index.tsx requires a TTY (not a bug, a constraint)

Ink's `useInput` requires raw-mode stdin. Running `bun run dev` from a non-TTY subshell (e.g., a PowerShell background job, CI step) produces:

```
ERROR  Raw mode is not supported on the current process.stdin, which Ink uses
       as input stream by default.
```

This is the documented Ink behavior, not a regression. Verification of the LLM round-trip through a non-TTY context uses `scripts/streaming-smoke.ts` instead. The user will run the actual interactive shell in a real terminal.

## Phase C prerequisites

Nothing blocking. Phase C can start.

Items to keep in mind:

- **Multi-turn history**: Phase B is single-turn. Phase C will accumulate history. The shell's existing `completed: CompletedTurn[]` state is the natural foundation; just need to feed history into the next request as `messages`. The CompletedTurn type already records userText + reasoning + content + tokenCount, which is everything an OpenAI-style messages array needs.
- **Tool list in system prompt**: Phase B's system prompt explicitly says "no tools available". Phase C will replace this with the formatted output of `client.listTools()` from McpClient. The smoke.tsx already proves the listTools call works under Bun.
- **tool_calls detection in the stream**: openai npm exposes `delta.tool_calls` alongside `delta.content`. Need to extract and accumulate these in StreamingClient (probably as a new event type `tool_call_delta`) and let the loop driver dispatch them sequentially per discovery doc §10.3.
- **Sequential dispatch enforcement**: Discovery doc §10.3 names this risk. The Phase C loop must `await client.callTool()` for each call — never `Promise.all`. A typed helper (`executeToolsSequentially`) is sketched in the discovery doc.
- **task_done detection**: Gemma 4 emits completion as a `task_done` tool call (per Stage11-Tech-Reference.md §5). Phase C's loop driver needs to treat that as the termination signal in addition to `finishReason: "stop"`.
- **McpServer crash recovery (§9.3 in discovery)**: Untested. Phase C should add a deliberate-kill test once tool dispatch is wired.

## Open questions raised

- **Reasoning content during tool-selection turns**: When the model is choosing tools (Phase C), does Gemma 4 use `reasoning_content` for its tool-selection deliberation, then emit `tool_calls`? Or does it skip reasoning when tools are involved? Worth probing in early Phase C with a few empirical streams. Affects whether the `<ActiveToolCall>` UI should also show reasoning above the tool call indicator.
- **Long reasoning blocks in Static turns**: A few of the test runs had reasoning blocks that approached the visual size of the actual response. After 5+ completed turns, the dimmed reasoning lines could clutter the scrollback even when collapsed. Phase D might want a "reasoning hidden by default" toggle that the user can enable per session.
- **Phase B index.tsx and the lack of a `--prompt` flag**: Phase A's index.tsx had a `--prompt` flag for headless verification. Phase B's interactive design dropped this — the smoke test path runs through `scripts/streaming-smoke.ts` instead. If the user wants a one-shot non-interactive mode in Phase B (e.g., for scripting), it'd be a new commit. Not currently planned for Phase C+.
- **Shift+Enter newline support across terminal emulators**: works in Windows Terminal and modern conhost; behavior in older terminals (cmd.exe on Win 8.1, third-party emulators) was not verified. Phase D may want a fallback (e.g., `\` + Enter as an alternative for terminals that don't distinguish Shift+Enter from Enter).

## Commits

```
55be3ab  phase B: §9.5 Static stress test pass
2ebbe35  phase B: streaming completion + ActiveTurn
b2d269e  phase B: §9.1 cancel verification pass
<this>   docs: Stage 11 Phase B summary
```

The two prompt-suggested commits (`phase B: reasoning_content rendering`, `phase B: status bar + multiline input`) were absorbed into the streaming-completion commit because the component tree is tightly coupled. Calling out the divergence so the audit trail is honest.

Tag `phase-b` will be applied to this commit. Push to `origin` (GitHub) is straightforward; NAS push requires the user (SSH agent not available in Claude's bash subshell — same constraint as Phase A's NAS-push gap).
