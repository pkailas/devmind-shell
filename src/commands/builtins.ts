// File: src/commands/builtins.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Initial five slash commands. Each is a small, isolated handler. Adding
// a new command later is one registerCommand call — no dispatcher edits.
//
// Persistence policy:
//   * /reasoning, /depth-cap → persisted to shell.json after success
//   * /clear, /system_prompt, /help → session-only (no persistence)
//
// Validation lives in the handler. Error CommandResults propagate to the
// UI as red turns; success results render in normal color. The registry
// catches handler exceptions, so I/O failures (e.g., persist) surface
// naturally as error results.

import { DEPTH_CAP_RANGE } from "../util/config.js";
import { persistConfigField } from "../util/configPersist.js";
import {
  registerCommand,
  listCommands,
  type CommandContext,
  type CommandResult,
} from "./registry.js";

// ── /reasoning on|off ───────────────────────────────────────────────────────

async function reasoningHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const arg = args[0]?.toLowerCase();
  if (arg !== "on" && arg !== "off") {
    return { message: "Usage: /reasoning on|off", isError: true };
  }
  const next = arg === "on";
  ctx.setConfig({ ...ctx.config, showReasoning: next });
  await persistConfigField("showReasoning", next);
  return { message: `Reasoning display: ${arg}` };
}

// ── /depth-cap [N] ──────────────────────────────────────────────────────────

async function depthCapHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    return { message: `Current depth cap: ${ctx.config.depthCap}` };
  }
  const raw = args[0];
  if (raw === undefined) {
    // Defensive — args.length > 0 should imply args[0] is defined, but
    // noUncheckedIndexedAccess wants the explicit guard.
    return {
      message: `Usage: /depth-cap [${DEPTH_CAP_RANGE.min}-${DEPTH_CAP_RANGE.max}]`,
      isError: true,
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < DEPTH_CAP_RANGE.min || n > DEPTH_CAP_RANGE.max) {
    return {
      message: `Usage: /depth-cap [${DEPTH_CAP_RANGE.min}-${DEPTH_CAP_RANGE.max}]`,
      isError: true,
    };
  }
  ctx.setConfig({ ...ctx.config, depthCap: n });
  await persistConfigField("depthCap", n);
  return { message: `Depth cap set to ${n}` };
}

// ── /clear ──────────────────────────────────────────────────────────────────

async function clearHandler(
  _args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  ctx.resetConversation();
  return { message: "Conversation cleared." };
}

// ── /system_prompt ──────────────────────────────────────────────────────────

async function systemPromptHandler(
  _args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  // Ignore arguments per spec. Output is wrapped in distinguishing
  // separators so it stands apart from regular model output.
  const prompt = ctx.getSystemPrompt();
  const top = "─── Current System Prompt ───";
  const bot = "─────────────────────────────";
  return { message: `${top}\n${prompt}\n${bot}` };
}

// ── /help ───────────────────────────────────────────────────────────────────

async function helpHandler(): Promise<CommandResult> {
  const all = listCommands();
  const lines = ["Available commands:"];
  // Pad usage column for alignment. "/system_prompt" is the widest at 14.
  const width = Math.max(...all.map((c) => c.usage.length), 0);
  for (const c of all) {
    lines.push(`  ${c.usage.padEnd(width)}  ${c.description}`);
  }
  return { message: lines.join("\n") };
}

// ── Registration ────────────────────────────────────────────────────────────

let registered = false;

/** Register all builtin commands. Idempotent — safe to call multiple
 *  times (registerCommand replaces existing entries). The flag avoids
 *  redundant work on hot reloads. */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  registerCommand(
    "/reasoning",
    "Toggle reasoning display (persisted)",
    "/reasoning on|off",
    reasoningHandler,
  );
  registerCommand(
    "/depth-cap",
    `Show or set agentic depth cap (${DEPTH_CAP_RANGE.min}-${DEPTH_CAP_RANGE.max}, persisted)`,
    "/depth-cap [N]",
    depthCapHandler,
  );
  registerCommand(
    "/clear",
    "Clear screen and reset conversation",
    "/clear",
    clearHandler,
  );
  registerCommand(
    "/system_prompt",
    "Display the assembled system prompt",
    "/system_prompt",
    systemPromptHandler,
  );
  registerCommand(
    "/help",
    "Show this list",
    "/help",
    helpHandler,
  );
}
