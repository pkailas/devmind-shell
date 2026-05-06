// File: src/loop/contextBudget.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Rolling-window context-budget trim. Estimates the size of the message
// array via a chars/4 approximation (cheap, good enough for 80%/95%
// thresholds; exact counts come from usage chunks but only after a round
// completes). When an estimate exceeds 80% of the configured ceiling,
// drops oldest non-system messages in pairs (assistant → tool sequence
// or assistant → user pair) until under threshold. At 95%, drops more
// aggressively, no preservation.
//
// Phase C deferred this with "no context-budget management". Phase D
// adds the simplest version that prevents catastrophic context overflow.
//
// Conservative defaults: 131K tokens for Gemma 4 (the configured ceiling
// in the discovery doc §6 + tech-reference §5). Trim thresholds match
// the WPF VSIX's pattern from DevMind/DevMind.md §"Budget Guard
// (always-on)": 80% soft trim, 95% hard trim.
//
// CRITICAL: never drop the system message (index 0). It's pinned.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

const DEFAULT_CONTEXT_TOKENS = 131_072; // Gemma 4 31B Dense Q8_0
const SOFT_TRIM_RATIO = 0.80;
const HARD_TRIM_RATIO = 0.95;
const CHARS_PER_TOKEN = 4; // approximation; openai's tiktoken is exact but heavy

export type TrimResult = {
  before: { messages: number; estimatedTokens: number };
  after: { messages: number; estimatedTokens: number };
  droppedMessages: number;
  trimMode: "soft" | "hard" | "none";
};

/** Estimate tokens via chars/4. Counts all string parts. */
export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          chars += part.text.length;
        }
      }
    }
    // tool_calls in assistant messages also consume tokens
    if (m.role === "assistant" && "tool_calls" in m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type === "function") {
          chars += (tc.function.name?.length ?? 0) + (tc.function.arguments?.length ?? 0);
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Trim the messages array in place. Returns the diagnostic record.
 * Drops messages from index 1 onward (preserving system at 0).
 *
 * Soft trim (80%): drop messages until under 70% (for hysteresis).
 * Hard trim (95%): drop until under 60%.
 *
 * Drops in MESSAGE-PAIR units when possible (assistant + tool, or
 * user + assistant). For tool-call sequences, drops the entire
 * assistant + tool group together to keep history well-formed.
 */
export function trimContext(
  messages: ChatCompletionMessageParam[],
  contextWindowTokens: number = DEFAULT_CONTEXT_TOKENS,
): TrimResult {
  const before = {
    messages: messages.length,
    estimatedTokens: estimateTokens(messages),
  };
  const softLimit = contextWindowTokens * SOFT_TRIM_RATIO;
  const hardLimit = contextWindowTokens * HARD_TRIM_RATIO;

  let trimMode: TrimResult["trimMode"] = "none";
  let targetTokens = contextWindowTokens;
  if (before.estimatedTokens >= hardLimit) {
    trimMode = "hard";
    targetTokens = contextWindowTokens * 0.60;
  } else if (before.estimatedTokens >= softLimit) {
    trimMode = "soft";
    targetTokens = contextWindowTokens * 0.70;
  } else {
    return {
      before,
      after: { ...before },
      droppedMessages: 0,
      trimMode: "none",
    };
  }

  // Drop in groups starting from index 1 (preserve system at 0).
  // A group is one of:
  //   - assistant (with tool_calls) + all matching tool messages
  //   - user message alone
  //   - assistant text-only message alone
  //   - tool message alone (orphan — shouldn't happen but be defensive)
  //
  // For Phase D we use a simpler heuristic: drop one message at a time
  // from index 1, but if an assistant-with-tool_calls is dropped, also
  // drop the matching tool messages immediately following it. This
  // preserves the protocol invariant that every tool_call_id has a
  // corresponding tool message.

  let dropped = 0;
  while (estimateTokens(messages) > targetTokens && messages.length > 1) {
    const m = messages[1];
    if (m === undefined) break;
    if (m.role === "assistant" && "tool_calls" in m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const toolCallIds = new Set(m.tool_calls.map((tc) => tc.id));
      messages.splice(1, 1); // drop the assistant message
      dropped++;
      // Drop any immediately-following tool messages whose tool_call_id
      // matches one we just dropped
      while (messages.length > 1) {
        const next = messages[1];
        if (next === undefined) break;
        if (next.role === "tool" && "tool_call_id" in next && typeof next.tool_call_id === "string" && toolCallIds.has(next.tool_call_id)) {
          messages.splice(1, 1);
          dropped++;
        } else {
          break;
        }
      }
    } else {
      messages.splice(1, 1);
      dropped++;
    }
  }

  return {
    before,
    after: {
      messages: messages.length,
      estimatedTokens: estimateTokens(messages),
    },
    droppedMessages: dropped,
    trimMode,
  };
}
