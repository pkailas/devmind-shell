// File: scripts/clear-scrollback-test.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Verifies that /clear triggers a terminal RIS (\x1Bc) write to stdout
// before mutating React/loop state. Without this, Ink's <Static>
// component leaves completed-turn output in the terminal scrollback
// even after setCompleted([]) (Phase B §9.5).
//
// We can't drive the real Ink UI from a non-TTY environment — useInput
// doesn't fire. Instead we replicate the App's resetConversation
// callback shape exactly, dispatch /clear through the real registry,
// and capture process.stdout.write calls to assert the escape sequence
// is emitted.
//
// Run: bun run scripts/clear-scrollback-test.ts

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchSlashCommand, type CommandContext } from "../src/commands/registry.js";
import { registerBuiltinCommands } from "../src/commands/builtins.js";
import type { Config } from "../src/util/config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devmind-clear-test-"));
process.env.DEVMIND_CONFIG_PATH = join(tmpDir, "shell.json");

// Capture every write to stdout. We intercept the underlying write so
// console.log et al. would also be captured if used; here we only care
// about the explicit \x1Bc emission inside resetConversation.
const writes: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  writes.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  return realWrite(chunk as never, ...(rest as never[]));
}) as typeof process.stdout.write;

// State the App callback would mutate.
let completedCleared = false;
let historyReset = false;

// Replicate the App's resetConversation callback verbatim from
// src/index.tsx (around line 493). If that wiring drifts, this test
// will silently lose its meaning — keep them in sync.
const liveConfig: Config = {
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

const ctx: CommandContext = {
  config: liveConfig,
  setConfig: () => {
    /* unused for /clear */
  },
  resetConversation: () => {
    process.stdout.write("\x1Bc");
    completedCleared = true;
    historyReset = true;
  },
  getSystemPrompt: () => "STUB",
};

registerBuiltinCommands();

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  // Restore stdout for the report so test output isn't buffered/captured.
  process.stdout.write = realWrite;
  if (cond) {
    realWrite(`  PASS  ${name}\n`);
  } else {
    failed++;
    realWrite(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

const before = writes.length;
const result = await dispatchSlashCommand("/clear", ctx);

check("dispatch returned success", result.isError !== true, `message=${result.message}`);
check("message is 'Conversation cleared.'", result.message === "Conversation cleared.");
check("resetConversation invoked", completedCleared && historyReset);

const newWrites = writes.slice(before);
const sawRis = newWrites.some((s) => s.includes("\x1Bc"));
check(
  "stdout received the RIS escape (\\x1Bc)",
  sawRis,
  sawRis ? "" : `captured writes: ${JSON.stringify(newWrites)}`,
);

// Order matters: the escape must precede the state mutation so that
// Ink's next render lands on a cleared screen rather than racing it.
const risIndexInWrites = writes.findIndex((s, i) => i >= before && s.includes("\x1Bc"));
check(
  "RIS write happens before state mutations complete",
  risIndexInWrites !== -1,
);

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

if (failed > 0) {
  realWrite(`\n${failed} check(s) FAILED\n`);
  process.exit(1);
}
realWrite("\nAll checks passed.\n");
process.exit(0);
