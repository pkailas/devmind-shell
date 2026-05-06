// File: src/loop/AgenticLoop.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Multi-round agentic loop: drives the streaming LLM, dispatches tool
// calls sequentially through McpClient, injects results, re-prompts,
// terminates on either text-only finish_reason="stop" or a `task_done`
// virtual tool call. Owns the conversation messages array.
//
// Architectural decisions (per discovery doc §3 + Phase C prompt):
//
//   * Shell owns the loop. McpServer is a passive tool provider.
//
//   * Sequential dispatch: tool calls within a round are dispatched
//     one at a time via `await` — never Promise.all. The C# server's
//     ConfigureAwaitOptions.ForceYielding does not guarantee
//     protocol-order under concurrent dispatch (discovery §10.3).
//
//   * task_done is a *virtual* tool — registered in the openai tools
//     array so the model can pick it from its tool list, but never
//     dispatched to McpServer (which doesn't have it). When emitted,
//     it terminates the loop. Matches the WPF VSIX ToolCallMapper
//     pattern (Stage11-Tech-Reference.md §5).
//
//   * History is a single ChatCompletionMessageParam[] passed fresh
//     to each LLM round. User messages, assistant text, tool_calls,
//     tool results all go in. reasoning_content does NOT — it's a
//     UX artifact, not model input. Re-feeding reasoning multiplies
//     token consumption without quality gain (per Phase C prompt).
//
//   * Crash recovery: one reconnect attempt on McpServer error.
//     If reconnect or retry fails, the turn aborts with a clear
//     error event. No retry loop (discovery §9.3 cap).
//
//   * Depth cap: 10 rounds per turn. Beyond that, the loop is
//     probably stuck — emit depth_cap and exit. WPF VSIX uses 5;
//     I'm being more generous here since the shell user can also
//     hit Esc.
//
//   * No context-budget management. Phase D problem.

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions/completions";
import { StreamingClient, type StreamEvent } from "../llm/StreamingClient.js";
import type { McpClient, ToolInfo, ToolResult } from "../mcp/McpClient.js";

const DEPTH_CAP = 10;

const TASK_DONE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "task_done",
    description:
      "Call this tool when the user's task is complete. Pass a brief summary " +
      "of what was done. This tool is virtual — it terminates the agentic loop.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A brief summary of what was accomplished." },
      },
      required: ["summary"],
    },
  },
};

const PROGRESS_TOOLS = new Set(["run_shell", "run_build", "run_tests"]);

export type LoopEvent =
  | { type: "round_started"; round: number }
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_dispatch"; id: string; name: string; args: unknown }
  | { type: "tool_call_progress"; id: string; line: string }
  | {
      type: "tool_call_result";
      id: string;
      name: string;
      result: string;
      isError: boolean;
    }
  | {
      type: "turn_complete";
      reason: "stop" | "task_done" | "error" | "depth_cap" | "abort";
      summary?: string;
      errorMessage?: string;
    };

type ParsedToolCall = {
  id: string;
  name: string;
  argsRaw: string;
  argsParsed: unknown;
  parseError: string | null;
};

export class AgenticLoop {
  private readonly _streaming: StreamingClient;
  private readonly _mcp: McpClient;
  private readonly _messages: ChatCompletionMessageParam[] = [];
  private readonly _tools: ChatCompletionTool[];
  private readonly _systemPrompt: string;

  constructor(opts: {
    streaming: StreamingClient;
    mcp: McpClient;
    mcpTools: ToolInfo[];
    systemPrompt: string;
  }) {
    this._streaming = opts.streaming;
    this._mcp = opts.mcp;
    this._systemPrompt = opts.systemPrompt;
    this._tools = [
      ...opts.mcpTools.map((t) => mcpToolToOpenAITool(t)),
      TASK_DONE_TOOL,
    ];
    this._messages.push({ role: "system", content: this._systemPrompt });
  }

  /** Used by the UI to display turn boundaries / debug state. */
  get messageCount(): number {
    return this._messages.length;
  }

  /** Reset history to system-prompt only. Used between sessions. */
  resetHistory(): void {
    this._messages.length = 0;
    this._messages.push({ role: "system", content: this._systemPrompt });
  }

  /** Run one user turn end-to-end. Yields events for UI rendering.
   *  Multiple LLM rounds may occur within a single turn (model
   *  emits tool_calls → we dispatch → re-prompt → repeat). */
  async *runTurn(
    userText: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<LoopEvent> {
    this._messages.push({ role: "user", content: userText });

    for (let round = 1; round <= DEPTH_CAP; round++) {
      yield { type: "round_started", round };

      const dispatchedCalls: ChatCompletionMessageToolCall[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];
      let assistantText = "";
      type FinishReason =
        | "stop"
        | "length"
        | "tool_calls"
        | "content_filter"
        | "function_call"
        | "abort"
        | null;
      let finishReason: FinishReason = null;
      let toolCallsAccum: { id: string; name: string; argumentsRaw: string }[] = [];

      try {
        for await (const ev of this._streaming.stream(this._messages, {
          tools: this._tools,
          signal: opts.signal,
        })) {
          if (ev.type === "reasoning_delta") {
            yield { type: "reasoning_delta", delta: ev.delta };
          } else if (ev.type === "content_delta") {
            assistantText += ev.delta;
            yield { type: "text_delta", delta: ev.delta };
          } else if (ev.type === "done") {
            finishReason = ev.finishReason;
            toolCallsAccum = ev.toolCalls;
          }
          // tool_call_start / tool_call_args_delta are not surfaced to the
          // UI in Phase C — args display happens at dispatch time. Could
          // be wired in later for arg-streaming preview UX.
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
        yield { type: "turn_complete", reason: "error", errorMessage: `LLM stream failed: ${message}` };
        return;
      }

      // Cancellation
      if (finishReason === "abort") {
        // Append a minimal assistant message so history is consistent
        if (assistantText.length > 0) {
          this._messages.push({ role: "assistant", content: assistantText });
        }
        yield { type: "turn_complete", reason: "abort" };
        return;
      }

      // Plain text response — turn done
      if (finishReason === "stop") {
        this._messages.push({ role: "assistant", content: assistantText });
        yield { type: "turn_complete", reason: "stop" };
        return;
      }

      if (finishReason !== "tool_calls") {
        yield {
          type: "turn_complete",
          reason: "error",
          errorMessage: `Unexpected finish_reason: ${String(finishReason)}`,
        };
        return;
      }

      // ── tool_calls round: parse, dispatch sequentially, collect results ──
      const parsed = parseToolCalls(toolCallsAccum);

      // Append the assistant message that contains the tool calls. Per OpenAI
      // protocol, every tool_call_id we want to feed back must appear in the
      // assistant message that precedes the tool messages.
      for (const p of parsed) {
        dispatchedCalls.push({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: p.argsRaw },
        });
      }
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: assistantText.length > 0 ? assistantText : null,
        tool_calls: dispatchedCalls,
      };
      this._messages.push(assistantMsg);

      // task_done is the termination signal. If present, dispatch to terminate.
      const taskDone = parsed.find((p) => p.name === "task_done");
      if (taskDone) {
        // Synthesize a tool result for completeness in history (some models
        // expect every tool_call to receive a tool message back)
        const summary =
          (taskDone.argsParsed as { summary?: string } | null)?.summary ?? "(no summary)";
        toolResults.push({
          tool_call_id: taskDone.id,
          content: `[task_done] ${summary}`,
        });
        // Emit a synthetic tool_call_result for UI consistency
        yield {
          type: "tool_call_dispatch",
          id: taskDone.id,
          name: "task_done",
          args: taskDone.argsParsed,
        };
        yield {
          type: "tool_call_result",
          id: taskDone.id,
          name: "task_done",
          result: summary,
          isError: false,
        };
        // Append tool messages so history is well-formed
        for (const r of toolResults) {
          this._messages.push({
            role: "tool",
            tool_call_id: r.tool_call_id,
            content: r.content,
          });
        }
        yield { type: "turn_complete", reason: "task_done", summary };
        return;
      }

      // Sequential dispatch
      for (const p of parsed) {
        if (opts.signal?.aborted) {
          yield { type: "turn_complete", reason: "abort" };
          return;
        }

        if (p.parseError) {
          // Synthesize an error tool result so the model sees what went wrong
          const errMsg = `[arguments parse error] ${p.parseError}\nraw: ${p.argsRaw}`;
          yield {
            type: "tool_call_dispatch",
            id: p.id,
            name: p.name,
            args: { _parse_error: p.parseError, _raw: p.argsRaw },
          };
          yield {
            type: "tool_call_result",
            id: p.id,
            name: p.name,
            result: errMsg,
            isError: true,
          };
          toolResults.push({ tool_call_id: p.id, content: errMsg });
          continue;
        }

        yield {
          type: "tool_call_dispatch",
          id: p.id,
          name: p.name,
          args: p.argsParsed,
        };

        const wantsProgress = PROGRESS_TOOLS.has(p.name);
        const args = (p.argsParsed ?? {}) as Record<string, unknown>;

        // Queue + signal pattern: onProgressLine fires synchronously
        // during the awaited callTool, but the async generator can't
        // yield from inside that callback (it's a separate async context).
        // So we queue lines and pump them out from the generator while
        // awaiting the callTool promise.
        const lineQueue: string[] = [];
        let pendingNotify: (() => void) | null = null;
        const notifyChange = () => {
          const r = pendingNotify;
          pendingNotify = null;
          r?.();
        };

        let resolvedResult: ToolResult | null = null;
        let resolvedError: unknown = null;
        let settled = false;

        const callPromise = this._mcp
          .callTool(p.name, args, {
            signal: opts.signal,
            timeoutMs: 600_000, // 10 min ceiling for run_build / run_tests
            ...(wantsProgress
              ? {
                  onProgressLine: (line) => {
                    lineQueue.push(line);
                    notifyChange();
                  },
                }
              : {}),
          })
          .then((r) => {
            resolvedResult = r;
          })
          .catch((e) => {
            resolvedError = e;
          })
          .finally(() => {
            settled = true;
            notifyChange();
          });

        // Pump loop: drain queued lines, wait for next event
        while (!settled) {
          while (lineQueue.length > 0) {
            yield { type: "tool_call_progress", id: p.id, line: lineQueue.shift()! };
          }
          if (settled) break;
          await new Promise<void>((resolve) => {
            pendingNotify = resolve;
          });
        }
        // Drain any final queued lines
        while (lineQueue.length > 0) {
          yield { type: "tool_call_progress", id: p.id, line: lineQueue.shift()! };
        }
        await callPromise; // ensure no unhandled-rejection in the .then chain

        let result: ToolResult;
        try {
          if (resolvedError) throw resolvedError;
          result = resolvedResult!;
        } catch (e: unknown) {
          // §9.3 crash recovery: try one reconnect + retry on McpServer error
          const message = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
          yield {
            type: "tool_call_progress",
            id: p.id,
            line: `[McpServer error: ${message}; attempting one reconnect]`,
          };
          try {
            await this._mcp.reconnect();
          } catch (reconnectErr: unknown) {
            const rmsg =
              reconnectErr instanceof Error
                ? `${reconnectErr.constructor.name}: ${reconnectErr.message}`
                : String(reconnectErr);
            yield {
              type: "tool_call_result",
              id: p.id,
              name: p.name,
              result: `McpServer connection lost — reconnect failed: ${rmsg}`,
              isError: true,
            };
            yield {
              type: "turn_complete",
              reason: "error",
              errorMessage: `McpServer reconnect failed; please restart the shell. (${rmsg})`,
            };
            return;
          }
          // Retry once. Progress streaming on the retry is best-effort —
          // we drop the queue/signal pump here for simplicity (a fresh
          // McpServer process won't have queued lines anyway).
          try {
            result = await this._mcp.callTool(p.name, args, {
              signal: opts.signal,
              timeoutMs: 600_000,
            });
            yield {
              type: "tool_call_progress",
              id: p.id,
              line: `[reconnect succeeded; tool call retried]`,
            };
          } catch (retryErr: unknown) {
            const rmsg =
              retryErr instanceof Error
                ? `${retryErr.constructor.name}: ${retryErr.message}`
                : String(retryErr);
            yield {
              type: "tool_call_result",
              id: p.id,
              name: p.name,
              result: `tool call failed after reconnect: ${rmsg}`,
              isError: true,
            };
            // Don't reset — feed the failure back to the model and continue
            toolResults.push({
              tool_call_id: p.id,
              content: `tool call failed after reconnect: ${rmsg}`,
            });
            continue;
          }
        }

        const resultText = renderToolResult(result);
        yield {
          type: "tool_call_result",
          id: p.id,
          name: p.name,
          result: resultText,
          isError: result.isError === true,
        };
        toolResults.push({ tool_call_id: p.id, content: resultText });
      }

      // Append tool messages — order matches the dispatchedCalls array
      for (const r of toolResults) {
        this._messages.push({
          role: "tool",
          tool_call_id: r.tool_call_id,
          content: r.content,
        });
      }

      // Loop continues — model gets to react to tool results in the next round
    }

    yield {
      type: "turn_complete",
      reason: "depth_cap",
      errorMessage: `Reached ${DEPTH_CAP} agentic rounds without resolution; aborting turn.`,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mcpToolToOpenAITool(t: ToolInfo): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  };
}

function parseToolCalls(
  toolCalls: { id: string; name: string; argumentsRaw: string }[],
): ParsedToolCall[] {
  return toolCalls.map((tc) => {
    let argsParsed: unknown = null;
    let parseError: string | null = null;
    const raw = tc.argumentsRaw.length > 0 ? tc.argumentsRaw : "{}";
    try {
      argsParsed = JSON.parse(raw);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    return {
      id: tc.id,
      name: tc.name,
      argsRaw: raw,
      argsParsed,
      parseError,
    };
  });
}

function renderToolResult(result: ToolResult): string {
  // McpServer tools predominantly return a single text content item.
  // Concatenate all text parts; non-text parts (image/resource) get a
  // placeholder. That's enough for Phase C — the model only needs the
  // text payload to reason about results.
  const parts: string[] = [];
  for (const c of result.content) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") parts.push(`[image content omitted: ${c.mimeType}]`);
    else parts.push(`[non-text content omitted]`);
  }
  return parts.join("\n");
}
