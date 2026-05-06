// File: scripts/slash-commands-test.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Headless test for the slash command framework. Exercises the registry,
// dispatcher, and all five built-in commands without launching Ink.
//
// Verifies:
//   - /help lists all five commands
//   - /reasoning on|off mutates config + persists
//   - /reasoning <bad-arg> returns error
//   - /depth-cap (no arg) prints current value
//   - /depth-cap N validates range 1..30
//   - /depth-cap 99 returns error, no persistence
//   - /clear invokes resetConversation
//   - /system_prompt returns the assembled prompt with separators
//   - /asdf returns unknown-command error
//
// Persistence is verified against a temp DEVMIND_CONFIG_PATH so we don't
// touch the user's real shell.json.
//
// Run: bun run scripts/slash-commands-test.ts

import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchSlashCommand, type CommandContext } from "../src/commands/registry.js";
import { registerBuiltinCommands } from "../src/commands/builtins.js";
import type { Config } from "../src/util/config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devmind-slash-test-"));
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

console.log("=== /help ===");
{
  const r = await dispatchSlashCommand("/help", ctx);
  check("includes /reasoning", r.message.includes("/reasoning"));
  check("includes /depth-cap", r.message.includes("/depth-cap"));
  check("includes /clear", r.message.includes("/clear"));
  check("includes /system_prompt", r.message.includes("/system_prompt"));
  check("includes /help", r.message.includes("/help"));
  check("not error", r.isError !== true);
}

console.log("\n=== /reasoning off (persists) ===");
{
  const r = await dispatchSlashCommand("/reasoning off", ctx);
  check("success message", r.message === "Reasoning display: off");
  check("liveConfig.showReasoning=false", liveConfig.showReasoning === false);
  const persisted = readPersisted();
  check("persisted false", persisted["showReasoning"] === false);
}

console.log("\n=== /reasoning on (persists) ===");
{
  const r = await dispatchSlashCommand("/reasoning on", ctx);
  check("success message", r.message === "Reasoning display: on");
  check("liveConfig.showReasoning=true", liveConfig.showReasoning === true);
  const persisted = readPersisted();
  check("persisted true", persisted["showReasoning"] === true);
}

console.log("\n=== /reasoning <bad-arg> ===");
{
  const r = await dispatchSlashCommand("/reasoning maybe", ctx);
  check("error", r.isError === true);
  check("usage message", r.message.includes("Usage: /reasoning on|off"));
}

console.log("\n=== /reasoning (missing arg) ===");
{
  const r = await dispatchSlashCommand("/reasoning", ctx);
  check("error", r.isError === true);
  check("usage message", r.message.includes("Usage: /reasoning on|off"));
}

console.log("\n=== /depth-cap (no arg) ===");
{
  const r = await dispatchSlashCommand("/depth-cap", ctx);
  check("not error", r.isError !== true);
  check("shows current", r.message === `Current depth cap: ${liveConfig.depthCap}`);
}

console.log("\n=== /depth-cap 20 (persists) ===");
{
  const r = await dispatchSlashCommand("/depth-cap 20", ctx);
  check("success message", r.message === "Depth cap set to 20");
  check("liveConfig.depthCap=20", liveConfig.depthCap === 20);
  const persisted = readPersisted();
  check("persisted 20", persisted["depthCap"] === 20);
}

console.log("\n=== /depth-cap 99 (out of range) ===");
{
  const before = readPersisted();
  const r = await dispatchSlashCommand("/depth-cap 99", ctx);
  check("error", r.isError === true);
  check("usage message", r.message.includes("Usage: /depth-cap"));
  check("config unchanged", liveConfig.depthCap === 20);
  const after = readPersisted();
  check("persisted unchanged", after["depthCap"] === before["depthCap"]);
}

console.log("\n=== /depth-cap 0 (out of range, low) ===");
{
  const r = await dispatchSlashCommand("/depth-cap 0", ctx);
  check("error", r.isError === true);
  check("config unchanged", liveConfig.depthCap === 20);
}

console.log("\n=== /depth-cap abc (non-integer) ===");
{
  const r = await dispatchSlashCommand("/depth-cap abc", ctx);
  check("error", r.isError === true);
}

console.log("\n=== /depth-cap 5.5 (non-integer) ===");
{
  const r = await dispatchSlashCommand("/depth-cap 5.5", ctx);
  check("error", r.isError === true);
  check("config unchanged", liveConfig.depthCap === 20);
}

console.log("\n=== /clear ===");
{
  const before = resetCount;
  const r = await dispatchSlashCommand("/clear", ctx);
  check("success message", r.message === "Conversation cleared.");
  check("resetConversation called once", resetCount === before + 1);
}

console.log("\n=== /system_prompt ===");
{
  const r = await dispatchSlashCommand("/system_prompt", ctx);
  check("not error", r.isError !== true);
  check("contains body", r.message.includes("STUB SYSTEM PROMPT BODY"));
  check("has top separator", r.message.includes("─── Current System Prompt ───"));
  check("has bottom separator", r.message.includes("─────────────────────────────"));
}

console.log("\n=== /asdf (unknown) ===");
{
  const r = await dispatchSlashCommand("/asdf", ctx);
  check("error", r.isError === true);
  check("suggests /help", r.message.includes("/help"));
}

console.log("\n=== Atomic-write verification ===");
{
  // After mutations there should be no leftover .tmp file.
  const tmpFile = `${tmpConfig}.tmp`;
  check("no leftover .tmp", !existsSync(tmpFile));
  const final = readPersisted();
  check("final showReasoning=true", final["showReasoning"] === true);
  check("final depthCap=20", final["depthCap"] === 20);
}

// Cleanup
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore — temp dir cleanup isn't load-bearing
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
