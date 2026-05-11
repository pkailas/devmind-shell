// File: src/commands/builtins.ts  v1.6
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Initial five slash commands. Each is a small, isolated handler. Adding
// a new command later is one registerCommand call — no dispatcher edits.
//
// Persistence policy:
//   * /reasoning, /depth-cap, /output-lines, /rules → persisted to
//     shell.json after success
//   * /clear, /system_prompt, /help → session-only (no persistence)
//
// Validation lives in the handler. Error CommandResults propagate to the
// UI as red turns; success results render in normal color. The registry
// catches handler exceptions, so I/O failures (e.g., persist) surface
// naturally as error results.

import { DEPTH_CAP_RANGE, OUTPUT_LINES_RANGE } from "../util/config.js";
import { deleteCurrentSessionLog } from "../util/trainingLogger.js";
import { persistConfigField } from "../util/configPersist.js";
import {
  registerCommand,
  listCommands,
  type CommandContext,
  type CommandResult,
} from "./registry.js";
import fs from "node:fs";
import path from "node:path";

// ── /reasoning on|off ───────────────────────────────────────────────────────

async function reasoningHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    return { message: `Reasoning display: ${ctx.config.showReasoning ? "on" : "off"}` };
  }
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

// ── /output-lines [N] ───────────────────────────────────────────────────────

async function outputLinesHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    const cur = ctx.config.outputLines;
    const note = cur === 0 ? " (unlimited)" : "";
    return { message: `Current output line limit: ${cur}${note}` };
  }
  const raw = args[0];
  if (raw === undefined) {
    // Defensive — args.length > 0 should imply args[0] is defined, but
    // noUncheckedIndexedAccess wants the explicit guard.
    return {
      message: `Usage: /output-lines [${OUTPUT_LINES_RANGE.min}-${OUTPUT_LINES_RANGE.max}] (0 = unlimited)`,
      isError: true,
    };
  }
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < OUTPUT_LINES_RANGE.min ||
    n > OUTPUT_LINES_RANGE.max
  ) {
    return {
      message: `Usage: /output-lines [${OUTPUT_LINES_RANGE.min}-${OUTPUT_LINES_RANGE.max}] (0 = unlimited)`,
      isError: true,
    };
  }
  ctx.setConfig({ ...ctx.config, outputLines: n });
  await persistConfigField("outputLines", n);
  return {
    message:
      n === 0
        ? "Output line limit set to 0 (unlimited)."
        : `Output line limit set to ${n}.`,
  };
}

// ── /clear ──────────────────────────────────────────────────────────────────

async function clearHandler(
  _args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  ctx.resetConversation();
  ctx.resetSessionTokens?.();
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

// ── /rules [text] ──────────────────────────────────────────────────────────

async function rulesHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  if (args.length === 0) {
    if (!ctx.config.behavioralRules) {
      return { message: "No behavioral rules set." };
    }
    return { message: `Current behavioral rules:\n${ctx.config.behavioralRules}` };
  }
 const arg = args[0];
  if (arg === undefined) {
    // Defensive — args.length > 0 but noUncheckedIndexedAccess.
    return { message: "No argument provided." };
  }
  if (arg === "clear") {
    ctx.setConfig({ ...ctx.config, behavioralRules: "" });
    await persistConfigField("behavioralRules", "");
    ctx.resetConversation();
    return { message: "Behavioral rules cleared. Conversation reset." };
  }
  ctx.setConfig({ ...ctx.config, behavioralRules: arg });
  await persistConfigField("behavioralRules", arg);
  ctx.resetConversation();
  return { message: "Behavioral rules updated. Conversation reset." };
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

// ── /training-delete-last ───────────────────────────────────────────────────────

async function trainingDeleteLastHandler(
  _args: string[],
  _ctx: CommandContext,
): Promise<CommandResult> {
  try {
    deleteCurrentSessionLog();
    return { message: "Current session training log deleted." };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { message: `Error deleting training log: ${msg}`, isError: true };
  }
}

// ── /dir [path] ──────────────────────────────────────────────────────────────────

async function dirHandler(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
 if (args.length === 0) {
    return { message: `Current working directory: ${process.cwd()}` };
  }
  const arg = args[0];
  let newDir: string;
  try {
    // Resolve relative to current process cwd (which is the current shell cwd)
    newDir = path.resolve(process.cwd(), arg ?? "");
    const stats = fs.statSync(newDir);
    if (!stats.isDirectory()) {
      return { message: `Error: The path "${arg}" is not a directory.`, isError: true };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { message: `Error: The path "${arg}" could not be resolved: ${msg}`, isError: true };
  }

  await ctx.setWorkingDir(newDir);
  return { message: `Working directory changed to: ${newDir}. MCP server reconnected.` };
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
    "/output-lines",
    `Show or set tool-call output line limit (${OUTPUT_LINES_RANGE.min}-${OUTPUT_LINES_RANGE.max}, 0 = unlimited, persisted)`,
    "/output-lines [N]",
    outputLinesHandler,
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
    "/rules",
    "Show, set, or clear behavioral rules (persisted; setting or clearing resets the conversation)",
    "/rules [text|clear]",
    rulesHandler,
  );
  registerCommand(
    "/training-delete-last",
    "Delete the training log for the current session",
    "/training-delete-last",
    trainingDeleteLastHandler,
  );
  registerCommand(
    "/dir",
    "Change working directory and reconnect MCP server",
    "/dir [path]",
    dirHandler,
  );
  registerCommand(
    "/help",
    "Show this list",
    "/help",
    helpHandler,
  );
}
