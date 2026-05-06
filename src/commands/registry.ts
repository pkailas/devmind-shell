// File: src/commands/registry.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Slash command registry + dispatcher. Hand-written, no dependencies.
//
// Architectural decisions:
//
//   * Commands are intercepted at the input boundary (before AgenticLoop
//     runs) so a slash command never burns model tokens. Recognition is
//     "input starts with '/'", parsed once into a token list; the first
//     token (without the leading slash) is the command name.
//
//   * The registry is a Map<name, RegisteredCommand>. Adding a command
//     later is one registerCommand() call — no dispatcher edits.
//
//   * Handlers receive a CommandContext with mutator callbacks for the
//     pieces of runtime state they need. Direct state access from
//     handlers would couple them to App's internals; the context is the
//     boundary. Handlers do NOT touch React state directly.
//
//   * CommandResult carries a render-ready message string + an isError
//     flag. The dispatcher does no rendering — that's the App's job.
//     This keeps the registry independent of Ink/React.
//
//   * Errors in handlers are caught and converted to error CommandResults
//     so a buggy handler doesn't crash the App turn-loop.

import type { Config } from "../util/config.js";

export type CommandContext = {
  /** Snapshot of the live runtime config — handlers may inspect freely. */
  config: Config;
  /** Replace the live runtime config. App re-renders against the new value. */
  setConfig: (next: Config) => void;
  /** Clear completed turns and the AgenticLoop message history. */
  resetConversation: () => void;
  /** Returns the SYSTEM_PROMPT string the loop would currently send. */
  getSystemPrompt: () => string;
};

export type CommandResult = {
  message: string;
  isError?: boolean;
};

export type CommandHandler = (
  args: string[],
  context: CommandContext,
) => Promise<CommandResult>;

type RegisteredCommand = {
  name: string;
  description: string;
  usage: string;
  handler: CommandHandler;
};

const commands: Map<string, RegisteredCommand> = new Map();

/** Register a slash command. Re-registering the same name overwrites
 *  (so tests can swap a handler without bookkeeping). */
export function registerCommand(
  name: string,
  description: string,
  usage: string,
  handler: CommandHandler,
): void {
  if (!name.startsWith("/")) {
    throw new Error(`command name must start with '/': got ${name}`);
  }
  commands.set(name, { name, description, usage, handler });
}

/** Iteration order is registration order (Map preserves insertion).
 *  Used by /help to render the command list. */
export function listCommands(): RegisteredCommand[] {
  return Array.from(commands.values());
}

/**
 * Parse a raw input line into command + args. Splits on whitespace.
 * Returns null if the input is not a slash command.
 *
 * Note: this is intentionally simple — no shell-style quoting. Commands
 * that need to accept text-with-spaces (e.g., a hypothetical /rules) can
 * recombine args[1..] internally.
 */
function parseInput(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const firstWhitespaceIndex = trimmed.search(/\s/);
  if (firstWhitespaceIndex === -1) {
    return { name: trimmed, args: [] };
  }

  const name = trimmed.substring(0, firstWhitespaceIndex);
  const rawArgs = trimmed.substring(firstWhitespaceIndex).trim();

  return {
    name,
    args: rawArgs === "" ? [] : [rawArgs],
  };
}

/**
 * Dispatch a slash command. Caller has already determined the input
 * starts with '/'. Returns a CommandResult; the App renders it.
 *
 * Unknown commands produce an error result suggesting /help. Handler
 * exceptions are caught and converted to error results.
 */
export async function dispatchSlashCommand(
  input: string,
  context: CommandContext,
): Promise<CommandResult> {
  const parsed = parseInput(input);
  if (parsed === null) {
    return { message: `not a slash command: ${input}`, isError: true };
  }
  const cmd = commands.get(parsed.name);
  if (cmd === undefined) {
    return {
      message: `unknown command: ${parsed.name}. Try /help for the list.`,
      isError: true,
    };
  }
  try {
    return await cmd.handler(parsed.args, context);
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    return { message: `${parsed.name} failed: ${msg}`, isError: true };
  }
}

/** True when input begins with '/'. Used by the App to decide whether
 *  to dispatch instead of starting an LLM turn. */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/");
}
