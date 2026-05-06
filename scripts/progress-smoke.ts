// File: scripts/progress-smoke.ts  v1.0
// Verify that MCP progress notifications flow live through the
// AgenticLoop -> tool_call_progress events. Runs a streaming tool
// (run_shell with a multi-line output) and prints each progress line
// with a timestamp so we can confirm they arrive incrementally rather
// than batched at the end.

import { McpClient } from "../src/mcp/McpClient.js";
import { StreamingClient } from "../src/llm/StreamingClient.js";
import { AgenticLoop } from "../src/loop/AgenticLoop.js";

const SERVER_PATH =
  "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe";
const WORKING_DIR = "C:/Users/pkailas/source/repos/DevMindShell";

const mcp = new McpClient();
await mcp.connect(SERVER_PATH, WORKING_DIR);
const tools = await mcp.listTools();
console.log(`[setup] McpServer ready, ${tools.length} tools`);

const streaming = new StreamingClient({
  baseURL: "http://10.0.0.15:8080/v1",
  apiKey: "lm-studio",
  model: "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf",
});

const loop = new AgenticLoop({
  streaming,
  mcp,
  mcpTools: tools,
  systemPrompt:
    `You are DevMindShell, a coding assistant. Working directory: ${WORKING_DIR}. ` +
    `When done, call task_done.`,
});

// Direct tool call without the LLM — exercises the progress pipe directly.
console.log(`\n--- direct callTool with onProgressLine ---`);
const t0 = performance.now();
const lineTimestamps: number[] = [];
const lines: string[] = [];

const result = await mcp.callTool(
  "run_shell",
  // Emit ~5 lines over ~5 seconds: 1 every second
  {
    command:
      "1..5 | ForEach-Object { Write-Output \"line $_\"; Start-Sleep -Seconds 1 }",
  },
  {
    onProgressLine: (line) => {
      const ts = performance.now() - t0;
      lineTimestamps.push(ts);
      lines.push(line);
      console.log(`  [+${ts.toFixed(0)}ms] ${line}`);
    },
    timeoutMs: 30_000,
  },
);

console.log(`\nTotal elapsed: ${(performance.now() - t0).toFixed(0)}ms`);
console.log(`Progress lines received: ${lines.length}`);
if (lineTimestamps.length >= 2) {
  const intervals: number[] = [];
  for (let i = 1; i < lineTimestamps.length; i++) {
    intervals.push(lineTimestamps[i]! - lineTimestamps[i - 1]!);
  }
  console.log(`Inter-line intervals (ms): ${intervals.map((n) => n.toFixed(0)).join(", ")}`);
  const incremental = intervals.every((i) => i > 200);
  console.log(`Incremental (intervals > 200ms each): ${incremental ? "YES" : "NO"}`);
}
console.log(`Final result content: ${(result.content[0] as { text?: string })?.text?.substring(0, 200) ?? ""}`);

await mcp.disconnect();
process.exit(0);
