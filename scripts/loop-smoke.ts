// File: scripts/loop-smoke.ts  v1.0
// Headless agentic-loop smoke test. Spawns McpServer, listTools(), runs
// one turn that requires read_file dispatch, prints all loop events.

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
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "lm-studio",
  model: "your-model-id-here",
  maxOutputTokens: 16384,
});

const SYSTEM_PROMPT =
  `You are DevMindShell, a coding assistant in a terminal. ` +
  `Working directory: ${WORKING_DIR}. ` +
  `When you have completed the user's task, call task_done with a brief summary.`;

const loop = new AgenticLoop({
  streaming,
  mcp,
  mcpTools: tools,
  systemPrompt: SYSTEM_PROMPT,
});

const userText = "Read package.json and tell me the value of the 'name' field. Then call task_done.";
console.log(`[user] ${userText}\n`);

let assistantText = "";
let reasoningCount = 0;
for await (const ev of loop.runTurn(userText)) {
  switch (ev.type) {
    case "round_started":
      console.log(`\n[round ${ev.round} started]`);
      break;
    case "reasoning_delta":
      reasoningCount += ev.delta.length;
      break;
    case "text_delta":
      assistantText += ev.delta;
      process.stdout.write(ev.delta);
      break;
    case "tool_call_dispatch":
      console.log(`\n[dispatch] ${ev.name} ${JSON.stringify(ev.args)}`);
      break;
    case "tool_call_progress":
      console.log(`  [progress] ${ev.line}`);
      break;
    case "tool_call_result":
      console.log(`[result] ${ev.name} (isError=${ev.isError}): ${ev.result.substring(0, 200)}${ev.result.length > 200 ? "..." : ""}`);
      break;
    case "turn_complete":
      console.log(`\n[turn_complete] reason=${ev.reason}${ev.summary ? ` summary="${ev.summary}"` : ""}${ev.errorMessage ? ` error="${ev.errorMessage}"` : ""}`);
      break;
  }
}

console.log(`\n--- summary ---`);
console.log(`reasoning chars: ${reasoningCount}`);
console.log(`assistant text chars: ${assistantText.length}`);
console.log(`history messages: ${loop.messageCount}`);

await mcp.disconnect();
process.exit(0);
