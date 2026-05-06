// File: src/util/path.ts  v1.0
// Forward-slash path conversion for subprocess arguments.
//
// Why this exists: the Stage 10 MCP Inspector testing turned up a bug
// where a Windows path like "C:\Users\pkailas\source\repos\Foo" gets
// arg-mangled because "\t" inside "\temp" or similar is interpreted as
// a literal tab character somewhere in the spawn pipeline. McpServer's
// own --dir validation now rejects malformed paths, but the shell's
// half of the contract is to never emit such paths in the first place.
//
// See docs/Stage11-Tech-Reference.md §6.

import { isAbsolute, resolve } from "path";

/**
 * Convert a path to forward-slash form suitable for passing to a
 * subprocess argument on Windows. Resolves to an absolute path first,
 * then replaces all backslashes with forward slashes.
 *
 * @throws if the input cannot be made absolute (only relevant for empty strings)
 */
export function toSubprocessPath(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(input);
  return absolute.replace(/\\/g, "/");
}
