// File: scripts/crash-test.ts  v1.0
// Discovery doc §9.3 verification: what does StdioClientTransport do
// when DevMind.McpServer.exe is killed mid-call?
//
// Method:
//   1. Start McpServer, list tools
//   2. Find McpServer's PID via tasklist
//   3. Run a long-ish tool (run_shell with a sleep)
//   4. From a background timer, kill McpServer at t=500ms
//   5. Observe what happens to the in-flight callTool() promise
//   6. Test the reconnect path — McpClient.reconnect() + retry the call
//
// Records verbatim:
//   - Behavior class: synchronous-throw / error-event / silent-drop
//   - Exact error message and stack
//   - Reconnect outcome
//
// Re-run: bun run scripts/crash-test.ts
// Evidence: scripts/crash-test-evidence.txt

import { McpClient } from "../src/mcp/McpClient.js";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const EVIDENCE_PATH = join(import.meta.dir, "crash-test-evidence.txt");
writeFileSync(EVIDENCE_PATH, "");
const log = (s: string) => {
  console.log(s);
  appendFileSync(EVIDENCE_PATH, s + "\n");
};

const SERVER_PATH =
  "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe";
const WORKING_DIR = "C:/Users/pkailas/source/repos/DevMindShell";

log(`=== §9.3 McpServer crash recovery verification ===`);
log(`Date: ${new Date().toISOString()}`);
log(`Bun: ${Bun.version}`);
log(``);

function findMcpServerPids(): number[] {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DevMind.McpServer.exe" /FO CSV /NH', {
      encoding: "utf8",
    });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      if (cols[0] === "DevMind.McpServer.exe" && cols[1]) {
        const pid = parseInt(cols[1], 10);
        if (!isNaN(pid)) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function killPid(pid: number): void {
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
  } catch (e) {
    log(`taskkill failed for pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Phase 1: connect, list tools ───────────────────────────────────────────
log(`--- Phase 1: connect ---`);
const mcp = new McpClient();
await mcp.connect(SERVER_PATH, WORKING_DIR);
const tools = await mcp.listTools();
log(`connected, ${tools.length} tools available`);

// Capture the McpServer PIDs that exist now. There should be exactly one
// new one (from this test) plus any from concurrent shells.
const initialPids = findMcpServerPids();
log(`McpServer PIDs visible: ${JSON.stringify(initialPids)}`);

// ── Phase 2: kill mid-call ──────────────────────────────────────────────────
log(``);
log(`--- Phase 2: kill mid-call ---`);

// Schedule the kill at t=500ms. We kill ALL McpServer PIDs to avoid the
// "which one is mine" problem. (Risk: if another shell session is open
// against the same Beast, this nukes it too. Acceptable for a one-shot
// verification.)
const KILL_DELAY_MS = 500;
let killFiredAt = 0;
const killTimer = setTimeout(() => {
  const pids = findMcpServerPids();
  killFiredAt = performance.now();
  log(`[+${killFiredAt.toFixed(0)}ms] killing McpServer PIDs: ${JSON.stringify(pids)}`);
  for (const pid of pids) killPid(pid);
}, KILL_DELAY_MS);

const callStartedAt = performance.now();
let behavior: "sync-throw" | "error-event" | "silent-drop" | "completed-normally" = "silent-drop";
let errorMessage = "";
let errorClass = "";

// run_shell with a 5-second sleep — long enough to be interrupted at 500ms.
// PowerShell `Start-Sleep -Seconds 5` should keep the call alive.
try {
  // Use Promise.race to detect silent-drop after a hard timeout
  const HARD_TIMEOUT_MS = 10_000; // 10 seconds — well past the 5s sleep + reasonable abort time
  // Start-Sleep is a PowerShell cmdlet (builtin) — no PATH resolution
  // needed (whereas ping.exe / powershell.exe require System32, which
  // McpServer's PowerShell subprocess context doesn't have on its PATH).
  const callPromise = mcp.callTool(
    "run_shell",
    { command: "Start-Sleep -Seconds 5; Write-Output done" },
    { timeoutMs: 30_000 },
  );
  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), HARD_TIMEOUT_MS),
  );
  const winner = await Promise.race([
    callPromise.then((r) => ({ kind: "result" as const, result: r })),
    timeoutPromise.then(() => ({ kind: "timeout" as const })),
  ]);

  const elapsed = performance.now() - callStartedAt;
  if (winner.kind === "timeout") {
    behavior = "silent-drop";
    log(`[+${elapsed.toFixed(0)}ms] call did NOT settle within ${HARD_TIMEOUT_MS}ms after kill — SILENT DROP`);
    errorMessage = "no error — call hung indefinitely";
  } else {
    behavior = "completed-normally";
    log(
      `[+${elapsed.toFixed(0)}ms] call resolved unexpectedly: isError=${winner.result.isError ?? "(undef)"}`,
    );
    log(`  content[0]: ${JSON.stringify(winner.result.content[0])?.substring(0, 200)}`);
  }
} catch (e: unknown) {
  const elapsed = performance.now() - callStartedAt;
  errorClass = e instanceof Error ? e.constructor.name : typeof e;
  errorMessage = e instanceof Error ? e.message : String(e);
  behavior = "sync-throw";
  log(`[+${elapsed.toFixed(0)}ms] callTool threw: ${errorClass}`);
  log(`  message: ${errorMessage}`);
  if (e instanceof Error && e.stack) {
    const stackLines = e.stack.split("\n").slice(0, 5);
    for (const line of stackLines) log(`  ${line}`);
  }
}

clearTimeout(killTimer);
const elapsedFromKill = killFiredAt > 0 ? performance.now() - killFiredAt : -1;
log(``);
log(`Behavior class: ${behavior}`);
log(`Time from kill to call resolution: ${elapsedFromKill.toFixed(0)}ms`);

// ── Phase 3: reconnect attempt ─────────────────────────────────────────────
log(``);
log(`--- Phase 3: reconnect ---`);
let reconnectOk = false;
try {
  await mcp.reconnect();
  reconnectOk = true;
  log(`reconnect succeeded`);
} catch (e: unknown) {
  log(`reconnect FAILED: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
}

// ── Phase 4: retry tool call ───────────────────────────────────────────────
let retryOk = false;
if (reconnectOk) {
  log(``);
  log(`--- Phase 4: retry the same tool call ---`);
  try {
    const retryResult = await mcp.callTool(
      "list_memory_topics",
      {},
      { timeoutMs: 15_000 },
    );
    retryOk = !retryResult.isError;
    log(`retry succeeded: isError=${retryResult.isError ?? false}`);
    log(`  content[0].text first 80 chars: ${(retryResult.content[0] as { text?: string })?.text?.substring(0, 80) ?? "(no text)"}`);
  } catch (e: unknown) {
    log(`retry FAILED: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────
log(``);
log(`=== Summary ===`);
log(`Initial call behavior: ${behavior}`);
if (behavior === "sync-throw") log(`  Error: ${errorClass}: ${errorMessage}`);
log(`Reconnect: ${reconnectOk ? "OK" : "FAIL"}`);
log(`Retry: ${retryOk ? "OK" : "FAIL/SKIPPED"}`);
const overall = behavior === "sync-throw" && reconnectOk && retryOk;
log(`OVERALL: ${overall ? "PASS — recoverable per AgenticLoop's existing reconnect path" : "FAIL or PARTIAL"}`);

await mcp.disconnect().catch(() => {});
process.exit(overall ? 0 : 1);
