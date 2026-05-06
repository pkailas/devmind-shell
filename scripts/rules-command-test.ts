// File: scripts/rules-command-test.ts
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Regression test for the /rules slash command.
//
// Verifies:
//   - /rules <text> updates config, persists to shell.json, and resets conversation
//   - /rules (no arg) clears rules, persists, and resets conversation
//   - Multi-word/multi-line rules are preserved exactly
//
// Run: bun run scripts/rules-command-test.ts

import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchSlashCommand, type CommandContext } from "../src/commands/registry.js";
import { registerBuiltinCommands } from "../src/commands/builtins.js";
import type { Config } from "../src/util/config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devmind-rules-test-"));
const tmpConfig = join(tmpDir, "shell.json");
process.env.DEVMIND_CONFIG_PATH = tmpConfig;

const baseConfig: Config = {
  baseURL: "http://test/v1",
  apiKey: "test",
  model: "test-model",
  mcpServerPath: "/dev/null",
  toolTimeoutMs: 30_000,
  behavioralRules: "",
  showReasoning: true,
  depthCap: 10,
  configFileLoaded: null,
};

let liveConfig: Config = { ...baseConfig };
let resetCount = 0;
const ctx: CommandContext = {
  get config() { return liveConfig; },
  setConfig: (next) => { liveConfig = next; },
  resetConversation: () => { resetCount++; },
  getSystemPrompt: () => "STUB SYSTEM PROMPT BODY",
} as unknown as CommandContext;

registerBuiltinCommands();

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function readPersisted(): Record<string, unknown> {
  if (!existsSync(tmpConfig)) return {};
  return JSON.parse(readFileSync(tmpConfig, "utf8")) as Record<string, unknown>;
}

console.log("=== /rules (non-empty, persists, resets) ===");
{
  const before = resetCount;
  const rulesText = "Be concise. Use TypeScript.";
  const r = await dispatchSlashCommand(`/rules ${rulesText}`, ctx);
  check("success message", r.message === "Behavioral rules updated. Conversation reset.");
  check("liveConfig.behavioralRules matches", liveConfig.behavioralRules === rulesText);
  const persisted = readPersisted();
  check("persisted rules match", persisted["behavioralRules"] === rulesText);
  check("resetConversation called", resetCount === before + 1);
}

console.log("\n=== /rules (empty, clears, resets) ===");
{
  const before = resetCount;
  const r = await dispatchSlashCommand("/rules", ctx);
  check("success message", r.message === "Behavioral rules cleared. Conversation reset.");
  check("liveConfig.behavioralRules empty", liveConfig.behavioralRules === "");
  const persisted = readPersisted();
  check("persisted rules empty", persisted["behavioralRules"] === "");
  check("resetConversation called", resetCount === before + 1);
}

console.log("\n=== /rules (multi-line preservation) ===");
{
  const multiLine = "Line 1\nLine 2\nLine 3";
  const r = await dispatchSlashCommand(`/rules ${multiLine}`, ctx);
  check("success message", r.message === "Behavioral rules updated. Conversation reset.");
  check("multi-line preserved", liveConfig.behavioralRules === multiLine);
  const persisted = readPersisted();
  check("persisted multi-line match", persisted["behavioralRules"] === multiLine);
}

// Cleanup
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
