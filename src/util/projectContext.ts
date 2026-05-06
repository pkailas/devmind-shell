// File: src/util/projectContext.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Discover and load project-context files (DevMind.md / CLAUDE.md /
// AGENTS.md) from the cwd. Mirrors the WPF VSIX's "Agent Context File
// Compatibility" feature documented in DevMind.md §"Agent Context File
// Compatibility":
//
//   On startup, DevMind searches for context files in this priority order:
//   1. DevMind.md (primary, project-specific context)
//   2. AGENTS.md (GitHub Copilot compatibility)
//   3. CLAUDE.md (Claude Code compatibility)
//
// Phase D inherits the same precedence with one important deviation:
// CLAUDE.md outranks AGENTS.md here. Reasoning:
//   - DevMind.md is project-native; always wins
//   - CLAUDE.md is what Claude Code reads — most actively-maintained
//     among community projects right now
//   - AGENTS.md is the GitHub Copilot convention; common in
//     Copilot-using repos, but the format is similar enough that the
//     tie-break rarely matters in practice
// If the project has multiple files, the WPF VSIX appends supplementary
// ones; we do the same here for parity (primary first, others as
// supplementary blocks).
//
// Cap on size: each file is read entirely if ≤32 KB, truncated with a
// note otherwise. The system prompt is the user-facing surface that
// reaches the LLM every turn — surprisingly large injections are a
// foot-gun against the context budget.

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

const CANDIDATES = ["DevMind.md", "CLAUDE.md", "AGENTS.md"] as const;
const MAX_FILE_BYTES = 32 * 1024;

export type LoadedContextFile = {
  filename: string;
  path: string;
  content: string;
  truncated: boolean;
};

/**
 * Discover context files in the cwd. Returns up to all three candidates
 * if present, in precedence order: DevMind.md, CLAUDE.md, AGENTS.md.
 * Files that don't exist are simply omitted. The first file is
 * "primary"; the rest are "supplementary."
 */
export function loadProjectContext(cwd: string): LoadedContextFile[] {
  const found: LoadedContextFile[] = [];
  for (const filename of CANDIDATES) {
    const path = join(cwd, filename);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const truncated = stat.size > MAX_FILE_BYTES;
    let content = readFileSync(path, "utf8");
    if (truncated) {
      content =
        content.substring(0, MAX_FILE_BYTES) +
        `\n\n[...truncated: file is ${stat.size} bytes; first ${MAX_FILE_BYTES} retained]`;
    }
    found.push({ filename, path, content, truncated });
  }
  return found;
}

/** Format the loaded context files into a system-prompt section.
 *  Returns the empty string if no context files were found. */
export function formatContextForPrompt(files: LoadedContextFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map((f, i) => {
    const header = i === 0 ? `[primary context: ${f.filename}]` : `[supplementary context: ${f.filename}]`;
    return `${header}\n${f.content}`;
  });
  return (
    `\n\n---\nThe following project-context files are present in the working directory ` +
    `and are appended below. Treat them as authoritative project conventions:\n\n` +
    blocks.join("\n\n---\n\n")
  );
}
