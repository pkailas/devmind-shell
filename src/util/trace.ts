// File: src/util/trace.ts  v1.2
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Per-run JSONL trace logging. Lazy — no disk I/O until the first
// traceEvent() or traceRunId() call.
//
// Record Schema: { ts, run_id, pid, role, level, event, data }
// Filename Pattern: <runId>.<role>.jsonl
//
// I/O is synchronous to ensure records are flushed before the next
// operation and to remain crash-resistant (diagnostic tool).
//
// DEVMIND_TRACE_RUN_ID: If set, is used as the runId to link traces
// across process boundaries.
//
// This is the DevMindShell-side trace logger. A matching C# implementation
// exists at DevMind.Core/Trace.cs on the McpServer side. Both write to
// the same .dm-trace/ directory using a shared runId (passed via
// DEVMIND_TRACE_RUN_ID) so traces from both sides can be correlated.

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { resolveConfig } from "./config.js";

const role = "shell";

let initialized = false;
let enabled = false;
let level: "info" | "debug" = "info";
let runId = "";
let logPath = "";
let initTime = 0;
let dirEnsured = false;
let shutdownFired = false;

function computeRunId(): string {
  const inherited = process.env.DEVMIND_TRACE_RUN_ID;
  if (inherited && inherited.length > 0) return inherited;
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "");
  // Transformation: 2026-05-07T19:30:45.123Z -> 2026-05-07T193045Z-pid12345
  return `${stamp}-pid${process.pid}`;
}

function init(): void {
  if (initialized) return;
  const cfg = resolveConfig();
  enabled = cfg.traceEnabled;
  level = cfg.traceLevel;
  runId = computeRunId();
  logPath = join(cfg.traceDir, `${runId}.${role}.jsonl`);
  initialized = true;
  initTime = Date.now();

  process.on("exit", () => {
    traceShutdown();
  });
}

function writeRecord(record: object): void {
  if (!dirEnsured) {
    mkdirSync(dirname(logPath), { recursive: true });
    dirEnsured = true;
  }
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}

export function traceEvent(
  evtLevel: "info" | "debug",
  event: string,
  data?: Record<string, unknown>,
): void {
  init();
  if (!enabled) return;
  if (evtLevel === "debug" && level === "info") return;

  const record = {
    ts: new Date().toISOString(),
    run_id: runId,
    pid: process.pid,
    role,
    level: evtLevel,
    event,
    data: data ?? {},
  };

  writeRecord(record);
}

export function traceRunId(): string {
  init();
  return runId;
}

export function traceShutdown(exitCode?: number): void {
  if (!initialized || shutdownFired) return;
  shutdownFired = true;
  traceEvent("info", "shell.exit", {
    exit_code: exitCode ?? null,
    duration_ms: Date.now() - initTime,
  });
}
