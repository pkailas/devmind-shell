// File: scripts/streaming-smoke.ts  v1.0
// Headless smoke test for StreamingClient. Verifies that reasoning_content
// + content + usage all flow through the typed event stream.

import { StreamingClient } from "../src/llm/StreamingClient.js";

const client = new StreamingClient({
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
  model: "your-model-id-here",
  maxOutputTokens: 16384,
});

let reasoning = "";
let content = "";
let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
let finishReason: string | null = null;
let reasoningEvents = 0;
let contentEvents = 0;

const t0 = performance.now();
for await (const ev of client.stream(
  [{ role: "user", content: "Say hi in three words." }],
  { maxTokens: 80, temperature: 0.0 },
)) {
  if (ev.type === "reasoning_delta") {
    reasoning += ev.delta;
    reasoningEvents++;
  } else if (ev.type === "content_delta") {
    content += ev.delta;
    contentEvents++;
  } else if (ev.type === "usage") {
    lastUsage = ev.usage;
  } else if (ev.type === "done") {
    finishReason = ev.finishReason;
  }
}
const elapsed = performance.now() - t0;

console.log(`elapsed: ${elapsed.toFixed(0)}ms`);
console.log(`reasoning events: ${reasoningEvents}, total chars: ${reasoning.length}`);
console.log(`content events: ${contentEvents}, total chars: ${content.length}`);
console.log(`usage: ${lastUsage ? JSON.stringify(lastUsage) : "(none)"}`);
console.log(`finishReason: ${finishReason}`);
console.log(`---reasoning:---\n${reasoning}`);
console.log(`---content:---\n${content}`);
