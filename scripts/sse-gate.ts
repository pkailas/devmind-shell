// File: scripts/sse-gate.ts  v1.0
// Phase A gate test: openai npm SSE streaming under Bun against ik_llama.cpp.
// Logs every delta with timestamps so we can confirm deltas arrive incrementally,
// not in a single batch at the end. Captures both delta.content and Gemma 4's
// chain-of-thought field delta.reasoning_content (ik_llama.cpp-specific).
//
// Re-run with: bun run gate
// Evidence written to scripts/sse-gate-evidence.txt
//
// PASS criteria:
//   - first delta arrives within ~1s
//   - inter-delta intervals are tens of ms (not all bunched at the end)
//   - assembled response is non-empty (combined content + reasoning_content)

import OpenAI from "openai";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";

const EVIDENCE_PATH = join(import.meta.dir, "sse-gate-evidence.txt");
writeFileSync(EVIDENCE_PATH, "");
const log = (s: string) => {
  console.log(s);
  appendFileSync(EVIDENCE_PATH, s + "\n");
};

const client = new OpenAI({
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
});

const MODEL = "your-model-id-here";

log(`=== Phase A SSE gate test ===`);
log(`Date: ${new Date().toISOString()}`);
log(`Bun: ${typeof Bun !== "undefined" ? Bun.version : "(not Bun)"}`);
log(`baseURL: http://127.0.0.1:1234/v1`);
log(`model: ${MODEL}`);
log(`prompt: "Say hi" with max_tokens=80`);
log(``);

const t0 = performance.now();
const stamps: number[] = [];
let deltaCount = 0;
let contentText = "";
let reasoningText = "";
let firstContentAt: number | null = null;

try {
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: "Say hi" }],
    stream: true,
    max_tokens: 80,
    temperature: 0.0,
  });

  log(`[+${(performance.now() - t0).toFixed(0)}ms] stream opened, awaiting first delta...`);

  for await (const chunk of stream) {
    const elapsed = performance.now() - t0;
    stamps.push(elapsed);
    deltaCount++;

    const delta = chunk.choices[0]?.delta as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;
    const content = delta?.content ?? "";
    const reasoning = delta?.reasoning_content ?? "";

    if (content) {
      contentText += content;
      if (firstContentAt === null) firstContentAt = elapsed;
    }
    if (reasoning) reasoningText += reasoning;

    if (deltaCount <= 3) {
      log(
        `[+${elapsed.toFixed(0)}ms] delta #${deltaCount}: content=${JSON.stringify(content)} reasoning=${JSON.stringify(reasoning)}`,
      );
    }
  }

  const tEnd = performance.now() - t0;
  log(``);
  log(`=== Stream complete ===`);
  log(`Total deltas: ${deltaCount}`);
  log(`Total elapsed: ${tEnd.toFixed(0)}ms`);
  log(`First delta arrived: +${stamps[0]?.toFixed(0)}ms`);
  log(`Last delta arrived:  +${stamps[stamps.length - 1]?.toFixed(0)}ms`);
  log(
    `First 9 inter-delta intervals (ms): ${stamps
      .slice(0, 10)
      .map((t, i, a) => (i === 0 ? null : (t - a[i - 1]!).toFixed(0)))
      .filter((x) => x !== null)
      .join(", ")}`,
  );
  log(``);
  log(`reasoning_content (Gemma 4 CoT, ${reasoningText.length} chars):`);
  log(reasoningText || "(none)");
  log(``);
  log(`content (${contentText.length} chars, first appeared at +${firstContentAt?.toFixed(0) ?? "n/a"}ms):`);
  log(contentText || "(none)");
  log(``);

  const incremental =
    deltaCount > 5 && (stamps[stamps.length - 1]! - stamps[0]!) > 100;
  const hasOutput = contentText.length > 0 || reasoningText.length > 0;
  const verdict = incremental && hasOutput ? "PASS" : "FAIL";
  log(`VERDICT: ${verdict}`);
  log(
    `  - incremental delivery: ${incremental ? "YES" : "NO"}  (${deltaCount} deltas spanning ${(stamps[stamps.length - 1]! - stamps[0]!).toFixed(0)}ms)`,
  );
  log(`  - output produced: ${hasOutput ? "YES" : "NO"}`);

  process.exit(verdict === "PASS" ? 0 : 1);
} catch (e: unknown) {
  log(`ERROR: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
  if (e instanceof Error && e.stack) log(e.stack);
  process.exit(1);
}
