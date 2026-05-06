// File: src/util/systemPrompt.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Pure assembly of the LLM system prompt from runtime inputs. Extracted
// from src/index.tsx so that the /system_prompt slash command can call
// it on demand and observe the same string the AgenticLoop would inject.
//
// Pure function: no side effects, no I/O. Caller is responsible for
// loading the project context (loadProjectContext) and passing the
// already-resolved Config in. That keeps the function trivially testable
// and makes the "current vs. snapshot" question explicit at the call
// site — the slash command calls it fresh with the live config, so the
// returned string reflects the latest state.

import type { Config } from "./config.js";
import { formatContextForPrompt, type LoadedContextFile } from "./projectContext.js";

export function assembleSystemPrompt(opts: {
  cwd: string;
  toolCount: number;
  config: Config;
  projectContext: LoadedContextFile[];
}): string {
  const { cwd, toolCount, config, projectContext } = opts;
  return (
    `You are DevMindShell, a coding assistant running in a terminal. ` +
    `Working directory: ${cwd.replace(/\\/g, "/")}. ` +
    `You have ${toolCount} tools available; use them to read, search, and modify files in the working directory. ` +
    `When you have completed the user's task, call task_done with a brief summary. ` +
    `Always read files before patching them. Use list_files or find_in_files for discovery — never assume a path.` +
    (config.behavioralRules ? `\n\n${config.behavioralRules}` : "") +
    formatContextForPrompt(projectContext)
  );
}
