// File: src/util/lifecycle.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Top-level shutdown coordinator. Owns signal handlers so that
// SIGINT/SIGTERM run a cleanup sequence regardless of where the app
// is in its lifecycle (Ink mid-render, mid-stream, idle, etc.).
//
// Cleanup is idempotent. A second signal force-exits with code 130
// (the conventional SIGINT exit code) so the user can always escape.
//
// On Windows, signals are emulated by Node/Bun: the terminal's
// CTRL_C_EVENT delivers SIGINT to the process; CTRL_BREAK_EVENT
// delivers SIGBREAK; taskkill without /F delivers SIGTERM. taskkill /F
// is unconditional TerminateProcess — no handler runs. (Per
// https://nodejs.org/api/process.html#processkillpid-signal.)

export type ShutdownStep = () => Promise<void> | void;

let cleanupCalled = false;
const steps: ShutdownStep[] = [];

/** Register a step to run during graceful shutdown. Steps run in
 *  registration order with errors swallowed (logged to stderr). */
export function onShutdown(step: ShutdownStep): void {
  steps.push(step);
}

/** Run the shutdown sequence once. Subsequent calls are no-ops. */
async function runCleanup(): Promise<void> {
  if (cleanupCalled) return;
  cleanupCalled = true;
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      process.stderr.write(
        `[shutdown] step failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

/** Install SIGINT and SIGTERM handlers. First signal triggers cleanup
 *  then exits with code 0. Second signal force-exits with 130. */
export function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals) => {
    if (cleanupCalled) {
      // Second signal: force-exit
      process.stderr.write(`\n[shutdown] received ${sig} during cleanup; force-exiting\n`);
      process.exit(130);
    }
    void runCleanup().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/** Are we already shutting down? Useful for early exits in async paths. */
export function isShuttingDown(): boolean {
  return cleanupCalled;
}
