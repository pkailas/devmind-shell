// File: src/util/config.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Configuration resolution: env vars > config file > defaults.
//
// Config file location is platform-correct, not XDG-everywhere:
//   Windows: %APPDATA%\devmind\shell.json
//            (AppData\Roaming per Microsoft conventions —
//             https://learn.microsoft.com/en-us/dotnet/api/system.environment.specialfolder)
//   macOS:   ~/Library/Application Support/devmind/shell.json
//            (Apple File System Programming Guide: "user-specific
//             support files used by the application")
//   Linux:   $XDG_CONFIG_HOME/devmind/shell.json or
//            ~/.config/devmind/shell.json
//            (XDG Base Directory Specification 0.8)
//
// Rationale: Windows users expect %APPDATA%, not dotfiles in their
// home directory. macOS likewise has its own convention. XDG-everywhere
// would surprise both. The platform-detection branch is ~10 lines.
//
// Env vars override the file. The full DEVMIND_* set:
//   DEVMIND_BASE_URL          — OpenAI-compatible endpoint URL
//   DEVMIND_API_KEY           — API key (literal "lm-studio" works for
//                                local llama-server)
//   DEVMIND_MODEL             — model id passed in chat.completions.create
//   DEVMIND_MCP_SERVER_PATH   — absolute path to DevMind.McpServer.exe
//   DEVMIND_TOOL_TIMEOUT_MS   — non-streaming tool-call timeout (default 30000)
//   DEVMIND_CONFIG_PATH       — explicit override of the config-file
//                                location (skips platform discovery)

import { homedir, platform } from "os";
import { join, resolve, dirname, isAbsolute } from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const DEFAULT_BASE_URL = "http://10.0.0.15:8080/v1";
const DEFAULT_API_KEY = "lm-studio";
const DEFAULT_MODEL = "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf";
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export type Config = {
  baseURL: string;
  apiKey: string;
  model: string;
  mcpServerPath: string;
  toolTimeoutMs: number;
  configFileLoaded: string | null; // for diagnostics
};

type ConfigFile = Partial<{
  baseURL: string;
  apiKey: string;
  model: string;
  mcpServerPath: string;
  toolTimeoutMs: number;
}>;

/** Default config-file path for the current platform.
 *  Per platform conventions; see header comment for citations. */
export function defaultConfigPath(): string {
  const p = platform();
  if (p === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "devmind", "shell.json");
    // Fallback: ~/AppData/Roaming/devmind/shell.json
    return join(homedir(), "AppData", "Roaming", "devmind", "shell.json");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "devmind", "shell.json");
  }
  // Linux/BSD: XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ?? join(homedir(), ".config"), "devmind", "shell.json");
}

function loadConfigFile(path: string): ConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`config file ${path} is not a JSON object`);
    }
    return parsed as ConfigFile;
  } catch (e) {
    throw new Error(
      `failed to read config file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Resolve final configuration.
 *  1. Determine config-file location: DEVMIND_CONFIG_PATH env or platform default.
 *  2. Read it if it exists. Missing file is fine (use defaults).
 *  3. Apply env-var overrides on top of the file values.
 *  4. Use built-in defaults for anything still unset.
 */
export function resolveConfig(): Config {
  const configPath = process.env.DEVMIND_CONFIG_PATH ?? defaultConfigPath();
  const file = loadConfigFile(configPath);
  const fileLoaded = file !== null ? configPath : null;

  const baseURL = process.env.DEVMIND_BASE_URL ?? file?.baseURL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.DEVMIND_API_KEY ?? file?.apiKey ?? DEFAULT_API_KEY;
  const model = process.env.DEVMIND_MODEL ?? file?.model ?? DEFAULT_MODEL;
  const mcpServerPath = resolveMcpServerPath(file?.mcpServerPath);
  const toolTimeoutMs = parseTimeoutMs(
    process.env.DEVMIND_TOOL_TIMEOUT_MS ?? file?.toolTimeoutMs?.toString(),
  );

  return {
    baseURL,
    apiKey,
    model,
    mcpServerPath,
    toolTimeoutMs,
    configFileLoaded: fileLoaded,
  };
}

function parseTimeoutMs(input: string | undefined): number {
  if (input === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * McpServer.exe path resolution chain (per discovery doc §7):
 *   1. DEVMIND_MCP_SERVER_PATH env var (absolute path)
 *   2. config file's mcpServerPath
 *   3. Adjacent build convention: relative to where the shell module lives.
 *      In dev, both repos clone as siblings. From src/util/, walk up to
 *      DevMindShell root, then over to the DevMind sibling, then into
 *      DevMind.McpServer/bin/{Release,Debug}/net8.0/DevMind.McpServer.exe.
 *      Tries Release first; falls back to Debug.
 *   4. PATH lookup (system command) — not implemented in v1; returns
 *      a clear error if all higher tiers fail.
 *
 * Throws if no tier resolves to a file that exists on disk.
 */
function resolveMcpServerPath(fromFile: string | undefined): string {
  const tried: string[] = [];

  const env = process.env.DEVMIND_MCP_SERVER_PATH;
  if (env) {
    tried.push(`env DEVMIND_MCP_SERVER_PATH=${env}`);
    if (existsSync(env)) return env;
  }

  if (fromFile) {
    const absolute = isAbsolute(fromFile) ? fromFile : resolve(fromFile);
    tried.push(`config file mcpServerPath=${absolute}`);
    if (existsSync(absolute)) return absolute;
  }

  // Adjacent build convention. import.meta.url points at this file
  // (src/util/config.ts). Walk up to DevMindShell, sideways to DevMind.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = .../DevMindShell/src/util  (or .../dist/...)
  const shellRoot = resolve(here, "..", "..");
  // siblingDir = .../<parent of DevMindShell>
  const siblingParent = resolve(shellRoot, "..");
  const siblingCandidates = [
    join(siblingParent, "DevMind", "DevMind.McpServer", "bin", "Release", "net8.0", "DevMind.McpServer.exe"),
    join(siblingParent, "DevMind", "DevMind.McpServer", "bin", "Debug", "net8.0", "DevMind.McpServer.exe"),
  ];
  for (const cand of siblingCandidates) {
    tried.push(`adjacent build ${cand}`);
    if (existsSync(cand)) return cand;
  }

  // PATH lookup — Windows: where.exe; POSIX: which. Skipped in v1; just
  // fail with the resolution chain printed so the user knows where to set things.
  const message =
    `Could not locate DevMind.McpServer.exe. Tried (in order):\n` +
    tried.map((t) => `  - ${t}`).join("\n") +
    `\n\nFix one of:\n` +
    `  - Set DEVMIND_MCP_SERVER_PATH=<absolute path to DevMind.McpServer.exe>\n` +
    `  - Set "mcpServerPath": "..." in ${defaultConfigPath()}\n` +
    `  - Build the DevMind sibling repo (Release or Debug, net8.0)\n`;
  throw new Error(message);
}

/** Pretty-print effective config for the startup banner. */
export function describeConfig(c: Config): string {
  return [
    `endpoint:    ${c.baseURL}`,
    `model:       ${c.model}`,
    `McpServer:   ${c.mcpServerPath}`,
    `timeout:     ${c.toolTimeoutMs}ms (non-streaming tools)`,
    `config file: ${c.configFileLoaded ?? "(none — using env + defaults)"}`,
  ].join("\n");
}
