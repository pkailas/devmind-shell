// File: src/util/configPersist.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Atomic persistence of individual config fields to shell.json.
//
// Pattern: write-to-temp-then-rename. fs.promises.rename is atomic on
// the same filesystem on Windows (MoveFileExW with MOVEFILE_REPLACE_EXISTING)
// and POSIX (rename(2)). A crash mid-write therefore cannot corrupt the
// existing shell.json — either the temp file exists (and gets cleaned
// up on next launch by being unrelated to the canonical path) or the
// rename completed.
//
// The shell.json path is resolved the same way config.ts reads it:
// DEVMIND_CONFIG_PATH env var, otherwise the platform default. This
// keeps read/write symmetrical so /reasoning off → relaunch reads the
// same file we just wrote.

import { dirname } from "path";
import { promises as fsp, existsSync } from "fs";
import { defaultConfigPath } from "./config.js";

/** Resolve the shell.json path the same way resolveConfig() does. */
function resolveConfigFilePath(): string {
  return process.env.DEVMIND_CONFIG_PATH ?? defaultConfigPath();
}

/** Read existing shell.json into a plain object. Missing or unreadable
 *  → empty object. Malformed JSON throws (we don't want to silently
 *  overwrite a hand-edited file the user is debugging). */
async function readExistingConfig(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const text = await fsp.readFile(path, "utf8");
  if (text.trim().length === 0) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Persist a single config field to shell.json atomically.
 *
 * 1. Read the current file (or {} if missing).
 * 2. Mutate the named field.
 * 3. Write to <path>.tmp.
 * 4. Rename <path>.tmp → <path> (atomic on same filesystem).
 *
 * Throws on any I/O or JSON failure. The caller should surface the
 * error to the user; we don't swallow.
 */
export async function persistConfigField(
  field: string,
  value: unknown,
): Promise<void> {
  const path = resolveConfigFilePath();
  const dir = dirname(path);

  // Ensure parent directory exists. On a fresh install %APPDATA%\devmind
  // may not exist yet — the original loadConfigFile() tolerates that
  // because it bails on existsSync(false), but writes need the directory.
  await fsp.mkdir(dir, { recursive: true });

  const current = await readExistingConfig(path);
  current[field] = value;

  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify(current, null, 2) + "\n";

  // Write the temp file. If a previous run left a stale .tmp it will be
  // overwritten — that's fine, we treat it as scratch.
  await fsp.writeFile(tmpPath, json, "utf8");

  // Atomic swap. On Windows, fs.promises.rename uses MoveFileExW with
  // MOVEFILE_REPLACE_EXISTING, which atomically replaces the destination.
  // On POSIX, rename(2) is atomic on the same filesystem.
  await fsp.rename(tmpPath, path);
}
