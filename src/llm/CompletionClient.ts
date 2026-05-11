// File: src/llm/CompletionClient.ts  v1.2
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Thin wrapper around the openai npm package against an OpenAI-compatible
// endpoint (ik_llama.cpp's llama-server). Phase A only does non-streaming
// completion; streaming arrives in Phase B.
//
// Critical: the openai npm package is used DIRECTLY. No provider-abstraction
// SDK (Vercel AI SDK, LangChain, etc.) — those have a track record of
// silently dropping the baseURL field and routing requests to api.openai.com.
// See docs/Stage11-Tech-Reference.md §5 and the opencode #5674 case study.

/**
 * CompletionClient provides a non-streaming interface for interacting with an 
 * OpenAI-compatible LLM endpoint (specifically ik_llama.cpp's llama-server).
 * 
 * Based on Phase A findings, this client is configured to handle Gemma 4 
 * models which emit chain-of-thought reasoning via the `reasoning_content` 
 * field in the response delta, separate from the final response content.
 */
import OpenAI from "openai";

/** Gemma 4 in ik_llama.cpp emits chain-of-thought via delta.reasoning_content
 *  and the actual response via delta.content. Both fields surface in the
 *  same response shape — see scripts/sse-gate.ts evidence file. */
export type CompletionResult = {
  content: string;
  reasoning: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export class CompletionClient {
  private readonly _client: OpenAI;
  private readonly _model: string;
  private readonly _maxOutputTokens: number;

  constructor(opts: { baseURL: string; apiKey: string; model: string; maxOutputTokens: number }) {
    this._client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this._model = opts.model;
    this._maxOutputTokens = opts.maxOutputTokens;
  }

  /** Non-streaming chat completion. Phase A interface. */
  async complete(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<CompletionResult> {
    const response = await this._client.chat.completions.create({
      model: this._model,
      messages,
max_tokens: opts.maxTokens ?? this._maxOutputTokens,
      temperature: opts.temperature ?? 0.0,
      stream: false,
    });

    const message = response.choices[0]?.message as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;

    return {
      content: message?.content ?? "",
      reasoning: message?.reasoning_content ?? "",
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
}
