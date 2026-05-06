// File: scripts/timeout-test.ts  v1.0
// Phase D §9.3 follow-up: verify that setting RequestOptions.timeout
// bounds the crash-to-error detection time. Phase C observed 4.5s for
// the SDK's internal close-detection. With timeoutMs: 2000, the SDK
// should reject sooner.
//
// Method (same as Phase C crash-test):
//   1. Connect, list tools
//   2. Start a 5s blocking call with timeoutMs: 2000
//   3. Kill McpServer at +500ms (so we know the subprocess is gone
//      BEFORE the timeout would fire on its own)
//   4. Measure when the call rejects
//
// Expected: rejection in ≤2.5s (the configured 2s timeout + small slop)
// rather than the Phase C 4.5s.

import { McpClient } from "../src/mcp/McpClient.js";
import { writeFileSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const RESULTS_PATH = join(import.meta.dir, "timeout-test-evidence.txt");
writeFileSync(RESULTS_PATH, "");
const log = (s: string) => {
  console.log(s);
  appendFileSync(RESULTS_PATH, s + "\n");
};

const SERVER_PATH =
  "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe";
const WORKING_DIR = "C:/Users/pkailas/source/repos/DevMindShell";

log(`=== Phase D timeout-bounded crash detection ===`);
log(`Date: ${new Date().toISOString()}`);
log(``);

function killAllMcpServer(): void {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DevMind.McpServer.exe" /FO CSV /NH', {
      encoding: "utf8",
    });
    for (const line of out.split("\n")) {
      const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      if (cols[0] === "DevMind.McpServer.exe" && cols[1]) {
        const pid = parseInt(cols[1], 10);
        if (!isNaN(pid)) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          } catch {}
        }
      }
    }
  } catch {}
}

const mcp = new McpClient();
await mcp.connect(SERVER_PATH, WORKING_DIR);
await mcp.listTools();

const TIMEOUT_MS = 2_000;
log(`tool-call timeout configured: ${TIMEOUT_MS}ms`);
log(``);

const callStartedAt = performance.now();
let killFiredAt = 0;

const killTimer = setTimeout(() => {
  killFiredAt = performance.now() - callStartedAt;
  log(`[+${killFiredAt.toFixed(0)}ms] killing McpServer`);
  killAllMcpServer();
}, 500);

let resolution: { kind: "throw" | "result"; elapsed: number; error?: string } = {
  kind: "throw",
  elapsed: 0,
};

try {
  await mcp.callTool(
    "run_shell",
    { command: "Start-Sleep -Seconds 5; Write-Output done" },
    { timeoutMs: TIMEOUT_MS },
  );
  resolution = { kind: "result", elapsed: performance.now() - callStartedAt };
  log(`[+${resolution.elapsed.toFixed(0)}ms] callTool resolved unexpectedly`);
} catch (e: unknown) {
  const elapsed = performance.now() - callStartedAt;
  resolution = {
    kind: "throw",
    elapsed,
    error: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e),
  };
  log(`[+${elapsed.toFixed(0)}ms] callTool threw: ${resolution.error}`);
}

clearTimeout(killTimer);
const detectionLatency = killFiredAt > 0 ? resolution.elapsed - killFiredAt : -1;
log(``);
log(`=== Summary ===`);
log(`Resolution time:   ${resolution.elapsed.toFixed(0)}ms after call start`);
log(`Detection latency: ${detectionLatency.toFixed(0)}ms after kill`);
log(`Phase C baseline:  4500ms (no explicit timeout)`);
log(`Phase D target:    <= ${TIMEOUT_MS + 500}ms (timeout + slop)`);

const pass = resolution.kind === "throw" && resolution.elapsed <= TIMEOUT_MS + 500;
log(`VERDICT: ${pass ? "PASS" : "FAIL"}`);

await mcp.disconnect().catch(() => {});
process.exit(pass ? 0 : 1);
