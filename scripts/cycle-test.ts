// File: scripts/cycle-test.ts  v1.0
// Phase C "Done when" criterion: a read → patch → build agentic cycle
// works end-to-end. Also exercises §9.4 parallel-tool-call observation
// across varied turns.
//
// Sets up a tiny throwaway target file in C:/temp/devmind-cycle/, then
// asks the model to read it, patch it, and run a build/shell command.
// Observes:
//   - whether multiple tool_calls appear in any single LLM round
//     (§9.4 parallel observation)
//   - whether reasoning_content appears during tool-selection rounds
//     (Phase B open question carried forward)
//   - the full event log for the read → patch → run cycle
//
// Re-run: bun run scripts/cycle-test.ts

import { McpClient } from "../src/mcp/McpClient.js";
import { StreamingClient } from "../src/llm/StreamingClient.js";
import { AgenticLoop } from "../src/loop/AgenticLoop.js";
import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";

const SERVER_PATH =
  "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe";
const WORKING_DIR = "C:/temp/devmind-cycle";
const EVIDENCE_PATH = join(import.meta.dir, "cycle-test-evidence.txt");

writeFileSync(EVIDENCE_PATH, "");
const log = (s: string) => {
  console.log(s);
  appendFileSync(EVIDENCE_PATH, s + "\n");
};

// ── Set up a clean working directory ────────────────────────────────────────
mkdirSync(WORKING_DIR, { recursive: true });
const targetFile = join(WORKING_DIR, "greet.ps1");
writeFileSync(
  targetFile,
  `# greet.ps1\nWrite-Output "hello"\n`,
);

log(`=== Phase C cycle test ===`);
log(`Date: ${new Date().toISOString()}`);
log(`Working dir: ${WORKING_DIR}`);
log(`Target file: greet.ps1 (initially: 'hello')`);
log(``);

// ── Connect ─────────────────────────────────────────────────────────────────
const mcp = new McpClient();
await mcp.connect(SERVER_PATH, WORKING_DIR);
const tools = await mcp.listTools();
log(`McpServer: ${tools.length} tools`);

const streaming = new StreamingClient({
  baseURL: "http://10.0.0.15:8080/v1",
  apiKey: "lm-studio",
  model: "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf",
});

const SYSTEM_PROMPT =
  `You are DevMindShell, a coding assistant in a terminal. ` +
  `Working directory: ${WORKING_DIR.replace(/\\/g, "/")}. ` +
  `You have ${tools.length} tools to read, search, modify files, and run shell commands. ` +
  `Always read a file before patching it. Use list_files for discovery; never assume paths. ` +
  `When the user's task is complete, call task_done with a brief summary.`;

const loop = new AgenticLoop({
  streaming,
  mcp,
  mcpTools: tools,
  systemPrompt: SYSTEM_PROMPT,
});

// ── Tracking across turns ───────────────────────────────────────────────────
type ParallelObservation = { turn: number; round: number; toolCount: number; toolNames: string[] };
const parallelObservations: ParallelObservation[] = [];
const reasoningPerRound: { turn: number; round: number; chars: number; toolsAfter: string[] }[] = [];

let turnCounter = 0;

async function runTurn(label: string, prompt: string): Promise<{ taskDone: boolean; finalText: string }> {
  turnCounter++;
  log(``);
  log(`================ Turn ${turnCounter}: ${label} ================`);
  log(`[user] ${prompt}`);

  let currentRound = 0;
  let reasoningThisRound = 0;
  let toolsThisRound: string[] = [];
  let finalText = "";
  let taskDone = false;

  for await (const ev of loop.runTurn(prompt)) {
    switch (ev.type) {
      case "round_started":
        // close out previous round's tracking
        if (currentRound > 0) {
          reasoningPerRound.push({
            turn: turnCounter,
            round: currentRound,
            chars: reasoningThisRound,
            toolsAfter: toolsThisRound,
          });
          if (toolsThisRound.length > 1) {
            parallelObservations.push({
              turn: turnCounter,
              round: currentRound,
              toolCount: toolsThisRound.length,
              toolNames: toolsThisRound,
            });
          }
        }
        currentRound = ev.round;
        reasoningThisRound = 0;
        toolsThisRound = [];
        log(`\n[round ${ev.round}]`);
        break;
      case "reasoning_delta":
        reasoningThisRound += ev.delta.length;
        break;
      case "text_delta":
        finalText += ev.delta;
        process.stdout.write(ev.delta);
        break;
      case "tool_call_dispatch":
        toolsThisRound.push(ev.name);
        log(`\n[dispatch] ${ev.name} ${JSON.stringify(ev.args).substring(0, 120)}`);
        break;
      case "tool_call_progress":
        log(`  [progress] ${ev.line}`);
        break;
      case "tool_call_result": {
        const summary =
          ev.result.length > 150 ? ev.result.substring(0, 147) + "..." : ev.result;
        log(`[result] ${ev.name} ${ev.isError ? "ERROR" : "ok"}: ${summary.replace(/\n/g, " | ")}`);
        break;
      }
      case "turn_complete":
        // Capture last round
        reasoningPerRound.push({
          turn: turnCounter,
          round: currentRound,
          chars: reasoningThisRound,
          toolsAfter: toolsThisRound,
        });
        if (toolsThisRound.length > 1) {
          parallelObservations.push({
            turn: turnCounter,
            round: currentRound,
            toolCount: toolsThisRound.length,
            toolNames: toolsThisRound,
          });
        }
        log(
          `\n[turn_complete] reason=${ev.reason}${ev.summary ? ` summary="${ev.summary}"` : ""}${ev.errorMessage ? ` error="${ev.errorMessage}"` : ""}`,
        );
        if (ev.reason === "task_done") taskDone = true;
        break;
    }
  }
  return { taskDone, finalText };
}

// ── Single-turn the full cycle ──────────────────────────────────────────────
const cyclePrompt =
  `Read greet.ps1, change the greeting from "hello" to "hello, world!", ` +
  `then run the patched script with run_shell to confirm it produces the new output. ` +
  `Then call task_done.`;

const cycleResult = await runTurn("read → patch → run cycle", cyclePrompt);

// ── Verify the file actually changed on disk ────────────────────────────────
const finalContent = readFileSync(targetFile, "utf8");
log(``);
log(`================ Verification ================`);
log(`File content after cycle:`);
log(finalContent);
const filePatchedCorrectly = finalContent.includes('"hello, world!"');
log(`File patched correctly: ${filePatchedCorrectly}`);

// ── Try a separate turn with multiple potential tool calls ──────────────────
const multiPrompt =
  `Now (1) list all files in the working directory, then (2) read greet.ps1 again, ` +
  `then call task_done with a one-sentence summary of the file contents.`;

await runTurn("multi-action turn (parallel-call observation)", multiPrompt);

// ── Summary ─────────────────────────────────────────────────────────────────
log(``);
log(`================ Summary ================`);
log(`Total turns: ${turnCounter}`);
log(`Total rounds: ${reasoningPerRound.length}`);
log(``);
log(`§9.4 Parallel tool calls observed?`);
if (parallelObservations.length === 0) {
  log(`  NOT OBSERVED in any round across ${turnCounter} turns / ${reasoningPerRound.length} rounds.`);
  log(`  Each tool_calls round emitted exactly one tool call.`);
} else {
  log(`  OBSERVED in ${parallelObservations.length} round(s):`);
  for (const o of parallelObservations) {
    log(`    Turn ${o.turn}, Round ${o.round}: ${o.toolCount} calls — [${o.toolNames.join(", ")}]`);
  }
}
log(``);
log(`Reasoning_content during tool-selection rounds?`);
const tsRounds = reasoningPerRound.filter((r) => r.toolsAfter.length > 0);
const textRounds = reasoningPerRound.filter((r) => r.toolsAfter.length === 0);
log(`  Tool-selection rounds: ${tsRounds.length}`);
log(`  Reasoning chars in tool-selection rounds: ${tsRounds.map((r) => r.chars).join(", ")}`);
log(`  Text-only rounds: ${textRounds.length}`);
log(`  Reasoning chars in text-only rounds: ${textRounds.map((r) => r.chars).join(", ")}`);
const tsHasReasoning = tsRounds.some((r) => r.chars > 0);
log(`  Verdict: reasoning_content ${tsHasReasoning ? "DOES" : "DOES NOT"} appear during tool-selection rounds.`);

log(``);
log(`Phase C "Done when" criteria:`);
log(`  Read tool dispatched: ${reasoningPerRound.some((r) => r.toolsAfter.includes("read_file") || r.toolsAfter.includes("list_files"))}`);
log(`  Patch tool dispatched: ${reasoningPerRound.some((r) => ["patch_file", "create_file", "append_file"].some((t) => r.toolsAfter.includes(t)))}`);
log(`  Build/run tool dispatched: ${reasoningPerRound.some((r) => r.toolsAfter.includes("run_shell") || r.toolsAfter.includes("run_build"))}`);
log(`  task_done emitted: ${cycleResult.taskDone}`);
log(`  File patched on disk: ${filePatchedCorrectly}`);

await mcp.disconnect();
process.exit(0);
