// File: src/util/lifecycle.ts  v1.1
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Top-level shutdown coordinator. Owns signal handlers so that
// SIGINT/SIGTERM run a cleanup sequence regardless of where the app
// is in its lifecycle (Ink mid-render, mid-stream, idle, etc.).
//
// Ctrl-C (SIGINT) handling:
// 1. If running: cancel the current turn, do not exit.
// 2. If idle (1st press): warn user, set exit-pending for 2s.
// 3. If idle (2nd press within 2s): run cleanup and exit 0.
// 4. If cleanup is already running: force-exit 130.
//
// SIGTERM always runs cleanup and exits 0.
//
// On Windows, signals are emulated by Node/Bun: the terminal's
// CTRL_C_EVENT delivers SIGINT to the process; CTRL_BREAK_EVENT
// delivers SIGBREAK; taskkill without /F delivers SIGTERM. taskkill /F
// is unconditional TerminateProcess — no handler runs. (Per
// https://nodejs.org/api/process.html#processkillpid-signal.)

export type ShutdownStep = () => Promise<void> | void;

let cleanupCalled = false;
const steps: ShutdownStep[] = [];

type LifecycleState = "idle" | "running" | "exit-pending";
let currentState: LifecycleState = "idle";
let exitPendingTimer: NodeJS.Timeout | null = null;
const cancelCallbacks: (() => void)[] = [];

/** Register a step to run during graceful shutdown. Steps run in
 *  registration order with errors swallowed (logged to stderr). */
export function onShutdown(step: ShutdownStep): void {
  steps.push(step);
}

export function setRunningState(running: boolean): void {
  if (running) {
    currentState = "running";
  } else {
    currentState = currentState === "exit-pending" ? "exit-pending" : "idle";
  }
}

export function getRunningState(): "idle" | "running" {
  return currentState === "running" ? "running" : "idle";
}

export function onCancelTurn(cb: () => void): void {
  cancelCallbacks.push(cb);
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
  process.on("SIGINT", () => {
    if (cleanupCalled) {
      process.stderr.write(`\n[shutdown] received SIGINT during cleanup; force-exiting\n`);
      process.exit(130);
    }

    if (currentState === "running") {
      process.stderr.write("\n[Ctrl+C] Cancelling turn...\n");
      for (const cb of cancelCallbacks) {
        cb();
      }
      return;
    }

    if (currentState === "idle") {
      currentState = "exit-pending";
      process.stderr.write("\n[Press Ctrl+C again to exit]\n");
      exitPendingTimer = setTimeout(() => {
        currentState = "idle";
        exitPendingTimer = null;
      }, 2000);
      return;
    }

    if (currentState === "exit-pending") {
      if (exitPendingTimer) {
        clearTimeout(exitPendingTimer);
        exitPendingTimer = null;
      }
      void runCleanup().then(
        () => process.exit(0),
        () => process.exit(1),
      );
      return;
    }
  });

  process.on("SIGTERM", () => {
    if (cleanupCalled) {
      process.stderr.write(`\n[shutdown] received SIGTERM during cleanup; force-exiting\n`);
      process.exit(130);
    }
    void runCleanup().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

/** Are we already shutting down? Useful for early exits in async paths. */
export function isShuttingDown(): boolean {
  return cleanupCalled;
}
