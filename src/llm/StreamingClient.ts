// File: src/llm/StreamingClient.ts  v2.3
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// v2.0 (Phase C): tool_calls delta surfacing. Emits per-tool-call events:
// tool_call_start (when a name first appears), tool_call_args_delta (each
// arguments fragment), and tool_call_complete (at finish_reason="tool_calls").
//
// Streaming tool_calls structure cited from openai npm 6.36.0:
//   resources/chat/completions/completions.d.ts:512  Delta.ToolCall
//     { index: number; id?: string; function?: { name?, arguments? }; type? }
// Per-delta shape: tool_calls is an array of partial ToolCall objects.
// `index` identifies which tool call a delta belongs to (parallel calls);
// `function.arguments` is a STRING fragment of the arguments JSON, accumulated
// across deltas. The model "does not always generate valid JSON" per the
// openai npm comment at line 503 — JSON.parse can fail. Caller handles.
// finish_reason: "tool_calls" signals end of tool-call accumulation
// (completions.d.ts:460). After the model dispatches tools and we feed
// results back, the next round may end with finish_reason: "stop" (text
// reply) or another "tool_calls" round.

import OpenAI, { APIUserAbortError } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

export type StreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_call_start";
      callIndex: number;
      callId: string;
      name: string;
    }
  | { type: "tool_call_args_delta"; callIndex: number; delta: string }
  | {
      type: "usage";
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
  | { type: "usage_report"; promptTokens: number; completionTokens: number }
  | {
      type: "done";
      finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | "abort" | null;
      // accumulatedToolCalls: keyed by callIndex; populated when finishReason === "tool_calls"
      toolCalls: Array<{ id: string; name: string; argumentsRaw: string }>;
    };

export class StreamingClient {
  private readonly _client: OpenAI;
  private readonly _model: string;
  private readonly _maxOutputTokens: number;

  constructor(opts: { baseURL: string; apiKey: string; model: string; maxOutputTokens: number }) {
    this._client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this._model = opts.model;
    this._maxOutputTokens = opts.maxOutputTokens;
  }

  /** Async iterable of stream events. Cancel via AbortSignal in opts.signal.
   *  Tools are only requested when opts.tools is non-empty; otherwise the
   *  request is text-only. */
  async *stream(
    messages: ChatCompletionMessageParam[],
    opts: {
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
      tools?: ChatCompletionTool[];
    } = {},
  ): AsyncIterable<StreamEvent> {
    let lastUsage: StreamEvent | null = null;
    let finishReason: StreamEvent["type"] extends "done"
      ? StreamEvent extends { type: "done"; finishReason: infer R }
        ? R
        : never
      : never = null as never;
    let finishReasonRaw:
      | "stop"
      | "length"
      | "tool_calls"
      | "content_filter"
      | "function_call"
      | null = null;

    // Per-call accumulators keyed by index
    type CallAcc = { id: string; name: string; argumentsRaw: string; nameEmitted: boolean };
    const calls = new Map<number, CallAcc>();

    const stream = await this._client.chat.completions.create(
      {
        model: this._model,
        messages,
max_tokens: opts.maxTokens ?? this._maxOutputTokens,
        temperature: opts.temperature ?? 0.0,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      },
      { signal: opts.signal },
    );

    try {
      for await (const chunk of stream) {
        if (opts.signal?.aborted) break;

        const choice = chunk.choices[0];
        const delta = choice?.delta as
          | {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
                type?: string;
              }>;
            }
          | undefined;

        if (delta?.reasoning_content) {
          yield { type: "reasoning_delta", delta: delta.reasoning_content };
        }
        if (delta?.content) {
          yield { type: "content_delta", delta: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let acc = calls.get(idx);
            if (!acc) {
              acc = { id: "", name: "", argumentsRaw: "", nameEmitted: false };
              calls.set(idx, acc);
            }
            if (tc.id && !acc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (acc.name && !acc.nameEmitted) {
              // Only emit the start event once we have a non-empty name AND an id
              if (acc.id) {
                acc.nameEmitted = true;
                yield {
                  type: "tool_call_start",
                  callIndex: idx,
                  callId: acc.id,
                  name: acc.name,
                };
              }
            }
            if (tc.function?.arguments) {
              acc.argumentsRaw += tc.function.arguments;
              yield {
                type: "tool_call_args_delta",
                callIndex: idx,
                delta: tc.function.arguments,
              };
            }
          }
        }
        if (choice?.finish_reason) {
          finishReasonRaw = choice.finish_reason;
        }
        if (chunk.usage) {
          // ik_llama.cpp emits usage on every chunk — keep the latest
          // (Stage11-Tech-Reference.md §5)
          lastUsage = {
            type: "usage",
            usage: {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            },
          };

          if (chunk.choices.length === 0) {
            yield {
              type: "usage_report",
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            };
          }
        }
      }
    } catch (e) {
      if (e instanceof APIUserAbortError || (opts.signal?.aborted ?? false)) {
        yield {
          type: "done",
          finishReason: "abort",
          toolCalls: Array.from(calls.values()).map((c) => ({
            id: c.id,
            name: c.name,
            argumentsRaw: c.argumentsRaw,
          })),
        };
        return;
      }
      throw e;
    }

    const wasAborted = opts.signal?.aborted ?? false;
    if (lastUsage && !wasAborted) yield lastUsage;
    yield {
      type: "done",
      finishReason: wasAborted ? "abort" : finishReasonRaw,
      toolCalls: Array.from(calls.values()).map((c) => ({
        id: c.id,
        name: c.name,
        argumentsRaw: c.argumentsRaw,
      })),
    };
  }
}
