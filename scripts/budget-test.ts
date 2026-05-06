// File: scripts/budget-test.ts  v1.0
// Verifies trimContext behavior at 80% (soft) and 95% (hard) thresholds
// against a configurable small ceiling (1000 tokens) so we can build
// large-enough synthetic histories without running real LLM rounds.

import { estimateTokens, trimContext } from "../src/loop/contextBudget.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

const CEILING = 1000;
const log = console.log;

function buildBigMessage(role: "user" | "assistant", contentChars: number): ChatCompletionMessageParam {
  return { role, content: "x".repeat(contentChars) };
}

function buildToolCallSequence(
  callId: string,
  argsChars: number,
  resultChars: number,
): ChatCompletionMessageParam[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "read_file", arguments: "x".repeat(argsChars) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: callId,
      content: "x".repeat(resultChars),
    },
  ];
}

let allOk = true;

// ── Case 1: under 80% — no trim ─────────────────────────────────────────────
{
  log(`--- Case 1: under 80% (no trim) ---`);
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "system prompt" },
    buildBigMessage("user", 100),
    buildBigMessage("assistant", 100),
  ];
  const result = trimContext(msgs, CEILING);
  log(`before: ${result.before.estimatedTokens} tokens, ${result.before.messages} msgs`);
  log(`after:  ${result.after.estimatedTokens} tokens, ${result.after.messages} msgs`);
  log(`trimMode: ${result.trimMode}, dropped: ${result.droppedMessages}`);
  const ok = result.trimMode === "none" && result.droppedMessages === 0;
  log(`Case 1: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) allOk = false;
  log(``);
}

// ── Case 2: between 80% and 95% — soft trim ─────────────────────────────────
{
  log(`--- Case 2: 80%–95% (soft trim, target 70%) ---`);
  // Build messages that roughly add to 850 tokens estimated (85%).
  // Each char counts as 1/4 token. 850 tokens = 3400 chars.
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "x".repeat(100) },
    buildBigMessage("user", 800),
    buildBigMessage("assistant", 800),
    buildBigMessage("user", 800),
    buildBigMessage("assistant", 800),
    buildBigMessage("user", 200),
  ];
  const before = estimateTokens(msgs);
  log(`pre-trim estimated: ${before} tokens (target ${(CEILING * 0.85).toFixed(0)})`);
  const result = trimContext(msgs, CEILING);
  log(`before: ${result.before.estimatedTokens} tokens, ${result.before.messages} msgs`);
  log(`after:  ${result.after.estimatedTokens} tokens, ${result.after.messages} msgs`);
  log(`trimMode: ${result.trimMode}, dropped: ${result.droppedMessages}`);
  const ok =
    result.trimMode === "soft" &&
    result.droppedMessages > 0 &&
    result.after.estimatedTokens <= CEILING * 0.7 + 50 && // small slop
    result.after.messages >= 1; // system preserved
  // Also verify system message is still at index 0
  const systemPreserved = msgs[0]?.role === "system";
  log(`system preserved: ${systemPreserved}`);
  log(`Case 2: ${ok && systemPreserved ? "PASS" : "FAIL"}`);
  if (!ok || !systemPreserved) allOk = false;
  log(``);
}

// ── Case 3: above 95% — hard trim ──────────────────────────────────────────
{
  log(`--- Case 3: above 95% (hard trim, target 60%) ---`);
  // Build messages totaling > 950 tokens.
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "x".repeat(100) },
    buildBigMessage("user", 1000),
    buildBigMessage("assistant", 1000),
    buildBigMessage("user", 1000),
    buildBigMessage("assistant", 1000),
  ];
  const result = trimContext(msgs, CEILING);
  log(`before: ${result.before.estimatedTokens} tokens, ${result.before.messages} msgs`);
  log(`after:  ${result.after.estimatedTokens} tokens, ${result.after.messages} msgs`);
  log(`trimMode: ${result.trimMode}, dropped: ${result.droppedMessages}`);
  const ok = result.trimMode === "hard" && result.after.estimatedTokens <= CEILING * 0.6 + 50;
  const systemPreserved = msgs[0]?.role === "system";
  log(`system preserved: ${systemPreserved}`);
  log(`Case 3: ${ok && systemPreserved ? "PASS" : "FAIL"}`);
  if (!ok || !systemPreserved) allOk = false;
  log(``);
}

// ── Case 4: tool call + result dropped together ─────────────────────────────
{
  log(`--- Case 4: tool_call + tool result drop atomically ---`);
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "x".repeat(100) },
    ...buildToolCallSequence("call_a", 800, 1000),
    ...buildToolCallSequence("call_b", 800, 1000),
    ...buildToolCallSequence("call_c", 800, 1000),
  ];
  const before = estimateTokens(msgs);
  log(`pre-trim estimated: ${before} tokens`);
  const result = trimContext(msgs, CEILING);
  log(`before: ${result.before.messages} msgs / ${result.before.estimatedTokens} tokens`);
  log(`after:  ${result.after.messages} msgs / ${result.after.estimatedTokens} tokens`);
  // Verify no orphan tool messages remain — every tool message should have a matching
  // assistant tool_call_id IMMEDIATELY before it.
  let orphanFound = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m && m.role === "tool" && "tool_call_id" in m) {
      const id = m.tool_call_id as string;
      // Walk back to find a matching tool_calls
      let matched = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = msgs[j];
        if (prev && prev.role === "assistant" && "tool_calls" in prev && Array.isArray(prev.tool_calls)) {
          for (const tc of prev.tool_calls) {
            if (tc.id === id) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        orphanFound = true;
        log(`  ORPHAN tool message at index ${i}: tool_call_id=${id}`);
      }
    }
  }
  log(`No orphan tool messages: ${!orphanFound}`);
  const ok = !orphanFound;
  log(`Case 4: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) allOk = false;
  log(``);
}

log(`OVERALL: ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
