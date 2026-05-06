// File: src/llm/StreamingClient.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Streaming variant of CompletionClient. Used DIRECTLY against the openai
// npm package (no provider-abstraction wrapper) per opencode #5674 lesson.
// See docs/Stage11-InkShell-Discovery.md §10.1.
//
// Yields a typed StreamEvent for each delta. Both delta.content and
// delta.reasoning_content are surfaced (Gemma 4 emits its CoT via the
// latter — see Stage11-Tech-Reference.md §5).
//
// Cancellation: pass an AbortSignal in opts.signal. The openai npm package
// forwards it to the underlying fetch and the for-await loop will throw
// when aborted; the caller must catch APIUserAbortError (or any error
// where signal.aborted is true) and treat it as a clean cancel.

import OpenAI, { APIUserAbortError } from "openai";

export type StreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "usage"; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "done"; finishReason: string | null };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class StreamingClient {
  private readonly _client: OpenAI;
  private readonly _model: string;

  constructor(opts: { baseURL: string; apiKey: string; model: string }) {
    this._client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this._model = opts.model;
  }

  /** Async iterable of stream events. Cancel via AbortSignal in opts.signal. */
  async *stream(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<StreamEvent> {
    let lastUsage: StreamEvent | null = null;
    let finishReason: string | null = null;

    const stream = await this._client.chat.completions.create(
      {
        model: this._model,
        messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.0,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: opts.signal },
    );

    try {
      for await (const chunk of stream) {
        if (opts.signal?.aborted) break;

        const choice = chunk.choices[0];
        const delta = choice?.delta as
          | { content?: string | null; reasoning_content?: string | null }
          | undefined;

        if (delta?.reasoning_content) {
          yield { type: "reasoning_delta", delta: delta.reasoning_content };
        }
        if (delta?.content) {
          yield { type: "content_delta", delta: delta.content };
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
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
        }
      }
    } catch (e) {
      if (e instanceof APIUserAbortError || (opts.signal?.aborted ?? false)) {
        // Treat aborts as a clean termination
        yield { type: "done", finishReason: "abort" };
        return;
      }
      throw e;
    }

    const wasAborted = opts.signal?.aborted ?? false;
    if (lastUsage && !wasAborted) yield lastUsage;
    yield { type: "done", finishReason: wasAborted ? "abort" : finishReason };
  }
}
