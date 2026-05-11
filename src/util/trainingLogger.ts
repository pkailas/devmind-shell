// File: src/util/trainingLogger.ts  v1.2
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Per-turn JSONL training data capture.
//
// Record Schema: { session_id, turn_id, timestamp, model, messages, outcome, target_index }
// Filename Pattern: <sessionId>.jsonl
//
// I/O is synchronous to ensure records are flushed before the next
// operation and to remain crash-resistant.
//
// This logger captures the full conversation history at the end of each
// agentic turn to provide high-quality data for LoRA fine-tuning.

import { appendFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { resolveConfig } from "./config.js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

export type TrainingTurnEntry = {
  session_id: string;
  turn_id: number;
  timestamp: string;
  model: string;
  messages: ChatCompletionMessageParam[]; // OpenAI-format chat messages
  outcome: "task_done" | "error" | "abort" | "depth_cap" | "finished_without_task_done" | "no_tool_calls_or_text";
  target_index: number;
};

let initialized = false;
let enabled = false;
let logDir = "";
let logPath = "";
let sessionId = "";
let turnCounter = 0;
let dirEnsured = false;

function computeSessionId(): string {
  const inherited = process.env.DEVMIND_TRACE_RUN_ID;
  if (inherited && inherited.length > 0) return inherited;
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "");
  return `${stamp}-pid${process.pid}`;
}

function init(): void {
  if (initialized) return;
  const cfg = resolveConfig();
  enabled = cfg.trainingLogEnabled;
  logDir = cfg.trainingLogDir;
  sessionId = computeSessionId();
  logPath = join(logDir, `${sessionId}.jsonl`);
  initialized = true;
}

export function logTurn(entry: Omit<TrainingTurnEntry, "session_id" | "turn_id" | "timestamp">): void {
  init();
  if (!enabled) return;

  turnCounter++;
  const fullEntry: TrainingTurnEntry = {
    ...entry,
    session_id: sessionId,
    turn_id: turnCounter,
    timestamp: new Date().toISOString(),
  };

  if (!logDir) return;
  if (!dirEnsured) {
    mkdirSync(dirname(logPath), { recursive: true });
    dirEnsured = true;
  }
  appendFileSync(logPath, JSON.stringify(fullEntry) + "\n", "utf8");
}

export function getSessionLogPath(): string | null {
  init();
  if (!enabled || !logPath) return null;
  return logPath;
}

export function deleteCurrentSessionLog(): void {
  init();
  if (!enabled || !logPath) return;
  try {
    unlinkSync(logPath);
    // Reset state so the next logTurn call reinitializes fresh.
    // If the user wants to keep logging this session, they shouldn't have deleted it.
    initialized = false;
    turnCounter = 0;
  } catch (e) {
    // Ignore if file doesn't exist
  }
}
