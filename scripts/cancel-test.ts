// File: scripts/cancel-test.ts  v1.0
// Discovery doc §9.1 verification: how fast does a streaming request
// terminate when the user cancels?
//
// Two abort vectors are tested:
//   1. AbortController.abort() while inside the for-await loop
//   2. AbortController.abort() called from a setTimeout (simulates the
//      Esc-key path: useInput → setTimeout 0 → abort)
//
// A third vector — process.kill(pid, 'SIGINT') — was attempted but
// is not testable from within the same process on Windows. Per the
// Node docs (https://nodejs.org/api/process.html#processkillpid-signal):
// "On Windows, the signal argument has no effect, and the process will
// be terminated unconditionally." So self-SIGINT terminates Bun.exe
// immediately and never reaches the registered handler. The SIGINT
// path in production is exercised when the user presses Ctrl+C in their
// terminal — the terminal delivers a real CTRL_C_EVENT to bun.exe,
// the registered handler in src/index.tsx runs abortRef.current.abort(),
// which exercises the same code path as vector #2 (already tested).
//
// Method:
//   - Issue a streaming request that the model will keep producing on
//     for 5+ seconds ("Write a 500-line poem")
//   - At t=500ms, fire the abort
//   - Measure: time from abort.abort() (or signal raise) to
//     for-await loop exit
//
// PASS criterion: cancel latency < 300ms (per discovery §9.1)
//
// Run: bun run scripts/cancel-test.ts
// Evidence: scripts/cancel-test-evidence.txt

import { StreamingClient } from "../src/llm/StreamingClient.js";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";

const EVIDENCE_PATH = join(import.meta.dir, "cancel-test-evidence.txt");
writeFileSync(EVIDENCE_PATH, "");
const log = (s: string) => {
  console.log(s);
  appendFileSync(EVIDENCE_PATH, s + "\n");
};

const client = new StreamingClient({
  baseURL: "http://10.0.0.15:8080/v1",
  apiKey: "lm-studio",
  model: "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf",
});

const LONG_PROMPT =
  "Write a 500-line free-verse poem about software engineering. Each line should be a different idea. Do not stop until you have written 500 lines.";

type Vector = "abort-direct" | "abort-via-settimeout";

async function runOnce(vector: Vector, runIdx: number): Promise<{ latencyMs: number; tokens: number; aborted: boolean }> {
  const abort = new AbortController();
  let tokens = 0;
  let aborted = false;
  let abortFiredAt = 0;
  let loopExitedAt = 0;
  const startedAt = performance.now();

  // Schedule the abort at t=500ms
  const ABORT_DELAY_MS = 500;
  let timer: NodeJS.Timeout | null = null;

  if (vector === "abort-direct") {
    timer = setTimeout(() => {
      abortFiredAt = performance.now();
      abort.abort();
    }, ABORT_DELAY_MS);
  } else if (vector === "abort-via-settimeout") {
    // Simulates the useInput → setTimeout(0) → abort path
    timer = setTimeout(() => {
      setTimeout(() => {
        abortFiredAt = performance.now();
        abort.abort();
      }, 0);
    }, ABORT_DELAY_MS);
  }

  try {
    for await (const ev of client.stream(
      [{ role: "user", content: LONG_PROMPT }],
      { signal: abort.signal, maxTokens: 4096, temperature: 0.0 },
    )) {
      if (ev.type === "content_delta" || ev.type === "reasoning_delta") {
        tokens++;
      } else if (ev.type === "done") {
        if (ev.finishReason === "abort") aborted = true;
      }
    }
  } catch (e: unknown) {
    aborted = abort.signal.aborted;
    if (!aborted) {
      log(`  unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  loopExitedAt = performance.now();

  if (timer) clearTimeout(timer);

  const latencyMs = abortFiredAt > 0 ? loopExitedAt - abortFiredAt : -1;
  log(
    `  run #${runIdx}: tokens=${tokens} aborted=${aborted} latency=${latencyMs.toFixed(0)}ms (start→abortFired=${(abortFiredAt - startedAt).toFixed(0)}ms, abortFired→loopExit=${latencyMs.toFixed(0)}ms)`,
  );
  return { latencyMs, tokens, aborted };
}

log(`=== §9.1 cancel verification ===`);
log(`Date: ${new Date().toISOString()}`);
log(`Bun: ${Bun.version}`);
log(`Pass criterion: latency < 300ms`);
log(``);

const results: { vector: Vector; latencies: number[] }[] = [];

for (const vector of ["abort-direct", "abort-via-settimeout"] as Vector[]) {
  log(`--- vector: ${vector} ---`);
  const latencies: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await runOnce(vector, i);
    if (r.aborted && r.latencyMs > 0) latencies.push(r.latencyMs);
    // Brief pause between runs to let the server settle
    await new Promise((r) => setTimeout(r, 500));
  }
  results.push({ vector, latencies });
  log(``);
}

log(`=== Summary ===`);
log(`| vector                | min (ms) | max (ms) | avg (ms) | verdict |`);
log(`|-----------------------|---------:|---------:|---------:|---------|`);
for (const r of results) {
  if (r.latencies.length === 0) {
    log(`| ${r.vector.padEnd(21)} |    n/a   |    n/a   |    n/a   | NO DATA |`);
    continue;
  }
  const min = Math.min(...r.latencies);
  const max = Math.max(...r.latencies);
  const avg = r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length;
  const pass = max < 300;
  log(
    `| ${r.vector.padEnd(21)} | ${min.toFixed(0).padStart(8)} | ${max.toFixed(0).padStart(8)} | ${avg.toFixed(0).padStart(8)} | ${pass ? "PASS" : "FAIL"}    |`,
  );
}

const overallPass = results.every((r) => r.latencies.length > 0 && Math.max(...r.latencies) < 300);
log(``);
log(`OVERALL VERDICT: ${overallPass ? "PASS" : "FAIL"}`);
process.exit(overallPass ? 0 : 1);
