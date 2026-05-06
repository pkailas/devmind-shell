// File: src/util/startup.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Pre-flight probes for things that fail loudly if they fail at all.
// All probes write directly to stderr with clear messages so the user
// sees them BEFORE Ink claims the terminal.

/**
 * Probe llama-server reachability via GET /v1/models. Returns null
 * if reachable, an error string if not. Doesn't throw — caller
 * decides whether to abort.
 *
 * Time-bounded with AbortController so a hung server doesn't stall
 * startup forever.
 */
export async function probeLlamaServer(
  baseURL: string,
  timeoutMs = 3_000,
): Promise<string | null> {
  const url = baseURL.replace(/\/$/, "") + "/models";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) {
      return `${url} returned HTTP ${r.status} ${r.statusText}`;
    }
    // Don't validate body shape — different OpenAI-compatible servers
    // return slightly different shapes (per Stage11-Tech-Reference.md §5).
    // Just confirm it's reachable and returning something.
    await r.text();
    return null;
  } catch (e: unknown) {
    if (controller.signal.aborted) {
      return `${url} did not respond within ${timeoutMs}ms`;
    }
    return `${url} unreachable: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Format and write a startup error block to stderr. */
export function writeStartupError(title: string, lines: string[]): void {
  const sep = "─".repeat(60);
  process.stderr.write(`\n${sep}\n${title}\n${sep}\n`);
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(`${sep}\n\n`);
}
