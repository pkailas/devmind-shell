// File: src/index.tsx  v4.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Phase C interactive shell: agentic loop with tool dispatch.
//
// Component tree per discovery doc §5:
//   <Static>     — completed turns (CompletedTurn renders user + reasoning + content + tool calls)
//   <ActiveTurn> — in-flight turn with <StreamingText>, <ReasoningBlock>, <ToolCallView>, <ToolOutputRegion>
//   <InputBox>   — multiline input (Shift+Enter newline; Enter submits)
//   <StatusBar>  — last in tree → bottom; shows current state, tool name during dispatch
//
// Multi-turn history accumulates in the AgenticLoop instance — turns
// reuse the same loop instance, so prior tool results stay in context.
//
// Cancel: Ctrl+C exits the app (process.on('SIGINT')); Esc aborts the
// current turn via the AbortController shared with AgenticLoop.runTurn().

import React, { useState, useEffect, useRef } from "react";
import { render, Text, Box, Static, useApp, useInput } from "ink";
import { McpClient, type ToolInfo } from "./mcp/McpClient.js";
import { StreamingClient } from "./llm/StreamingClient.js";
import { AgenticLoop, type LoopEvent } from "./loop/AgenticLoop.js";
import { installSignalHandlers, onShutdown } from "./util/lifecycle.js";
import { resolveConfig, describeConfig } from "./util/config.js";
import { loadProjectContext, formatContextForPrompt } from "./util/projectContext.js";

const PROGRESS_TOOLS = new Set(["run_shell", "run_build", "run_tests"]);
const MAX_PROGRESS_LINES_VISIBLE = 12; // collapse longer streams

type Phase = "input" | "streaming" | "error";

type ToolCallEntry = {
  id: string;
  name: string;
  args: unknown;
  result: string | null;
  isError: boolean | null;
  progress: string[];
  status: "dispatching" | "running" | "done";
};

type CompletedTurn = {
  id: number;
  userText: string;
  reasoning: string;
  text: string;
  toolCalls: ToolCallEntry[];
  doneReason: string;
  doneSummary: string | undefined;
  errorMessage: string | undefined;
};

type ActiveTurnState = {
  userText: string;
  reasoning: string;
  text: string;
  toolCalls: ToolCallEntry[];
  currentRound: number;
  startedAt: number;
};

// ── Sub-components ──────────────────────────────────────────────────────────

function ReasoningBlock({
  text,
  expanded,
  streaming,
}: {
  text: string;
  expanded: boolean;
  streaming: boolean;
}) {
  if (text.length === 0) return null;
  const approxTokens = Math.ceil(text.length / 4);
  const arrow = expanded ? "▼" : "▶";
  const header = streaming
    ? `${arrow} thinking... (~${approxTokens} tokens)`
    : `${arrow} thinking (~${approxTokens} tokens)${expanded ? "" : " — collapsed"}`;
  return (
    <Box flexDirection="column" marginBottom={expanded ? 1 : 0}>
      <Text dimColor>{header}</Text>
      {expanded && <Text dimColor>{text}</Text>}
    </Box>
  );
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  try {
    const json = JSON.stringify(args);
    if (json.length > 80) return json.substring(0, 77) + "...";
    return json;
  } catch {
    return "(unserializable)";
  }
}

function summarizeResult(result: string, isError: boolean): string {
  // Take the first non-empty line and trim
  const firstLine = result.split("\n").find((l) => l.trim().length > 0) ?? "(empty)";
  const truncated = firstLine.length > 100 ? firstLine.substring(0, 97) + "..." : firstLine;
  const lineCount = result.split("\n").length;
  const suffix = lineCount > 1 ? `  (+${lineCount - 1} more lines)` : "";
  return (isError ? "✗ " : "") + truncated + suffix;
}

function ToolOutputRegion({ lines, status }: { lines: string[]; status: ToolCallEntry["status"] }) {
  if (lines.length === 0 && status !== "running") return null;
  const visible = lines.slice(-MAX_PROGRESS_LINES_VISIBLE);
  const hidden = lines.length - visible.length;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {hidden > 0 && <Text dimColor>… {hidden} earlier line(s) omitted</Text>}
      {visible.map((l, i) => (
        <Text key={i} dimColor>
          {l}
        </Text>
      ))}
    </Box>
  );
}

function ToolCallView({ call, isActive }: { call: ToolCallEntry; isActive: boolean }) {
  const isStreaming = PROGRESS_TOOLS.has(call.name);
  const argsSummary = summarizeArgs(call.args);
  const arrow = call.status === "done" ? "→" : "→";
  const headerColor =
    call.status === "done" ? (call.isError ? "red" : "green") : "yellow";
  return (
    <Box flexDirection="column" marginY={0}>
      <Text>
        <Text color={headerColor}>{`[${arrow} ${call.name}`}</Text>
        {argsSummary.length > 0 && <Text dimColor>{` ${argsSummary}`}</Text>}
        <Text color={headerColor}>{`]`}</Text>
      </Text>
      {isStreaming && isActive && call.status !== "done" && (
        <ToolOutputRegion lines={call.progress} status={call.status} />
      )}
      {call.status === "done" && call.result !== null && (
        <Text>
          <Text color={call.isError ? "red" : "cyan"}>{"  [← "}</Text>
          <Text>{summarizeResult(call.result, call.isError === true)}</Text>
          <Text color={call.isError ? "red" : "cyan"}>{"]"}</Text>
        </Text>
      )}
    </Box>
  );
}

function CompletedTurnView({ turn }: { turn: CompletedTurn }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <ReasoningBlock text={turn.reasoning} expanded={false} streaming={false} />
      {turn.text.length > 0 && <Text>{turn.text}</Text>}
      {turn.toolCalls.map((c) => (
        <ToolCallView key={c.id} call={c} isActive={false} />
      ))}
      {turn.doneReason === "task_done" && turn.doneSummary && (
        <Text color="green">✓ {turn.doneSummary}</Text>
      )}
      {turn.doneReason === "abort" && <Text color="yellow">[cancelled]</Text>}
      {turn.doneReason === "error" && turn.errorMessage && (
        <Text color="red">✗ {turn.errorMessage}</Text>
      )}
      {turn.doneReason === "depth_cap" && turn.errorMessage && (
        <Text color="red">✗ {turn.errorMessage}</Text>
      )}
    </Box>
  );
}

function ActiveTurn({ turn }: { turn: ActiveTurnState }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <ReasoningBlock
        text={turn.reasoning}
        expanded={true}
        streaming={turn.text.length === 0 && turn.toolCalls.length === 0}
      />
      {turn.text.length > 0 && <Text>{turn.text}</Text>}
      {turn.toolCalls.map((c, i) => (
        <ToolCallView key={c.id} call={c} isActive={i === turn.toolCalls.length - 1} />
      ))}
    </Box>
  );
}

function InputBox({ buffer, active }: { buffer: string; active: boolean }) {
  const lines = buffer.length === 0 ? [""] : buffer.split("\n");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? "green" : "gray"}
      paddingX={1}
    >
      {lines.map((line, i) => (
        <Box key={i}>
          {i === 0 ? <Text color="green">{"> "}</Text> : <Text>{"  "}</Text>}
          <Text>{line}</Text>
          {active && i === lines.length - 1 && <Text color="gray">▌</Text>}
        </Box>
      ))}
    </Box>
  );
}

function StatusBar({
  phase,
  active,
  elapsedMs,
  toolsCount,
}: {
  phase: Phase;
  active: ActiveTurnState | null;
  elapsedMs: number;
  toolsCount: number;
}) {
  if (phase === "streaming" && active) {
    const lastCall = active.toolCalls[active.toolCalls.length - 1];
    const inToolDispatch = lastCall && lastCall.status !== "done";
    if (inToolDispatch && lastCall) {
      return (
        <Text>
          <Text color="yellow">■ Running: </Text>
          <Text>{lastCall.name}</Text>
          <Text dimColor>
            {" "}({(elapsedMs / 1000).toFixed(1)}s, round {active.currentRound})  [Esc to cancel]
          </Text>
        </Text>
      );
    }
    return (
      <Text>
        <Text color="yellow">■ Generating... </Text>
        <Text dimColor>
          ({(elapsedMs / 1000).toFixed(1)}s, round {active.currentRound})  [Esc to cancel]
        </Text>
      </Text>
    );
  }
  if (phase === "error") {
    return <Text color="red">✗ Error</Text>;
  }
  return (
    <Text>
      <Text color="green">○ Ready </Text>
      <Text dimColor>
        ({toolsCount} tools available · Enter to send · Shift+Enter newline · Ctrl+C to exit)
      </Text>
    </Text>
  );
}

// ── Main app ────────────────────────────────────────────────────────────────

function App({
  loop,
  toolsCount,
  banner,
}: {
  loop: AgenticLoop;
  toolsCount: number;
  banner: string[];
}) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("input");
  const [buffer, setBuffer] = useState<string>("");
  const [completed, setCompleted] = useState<CompletedTurn[]>([]);
  const [active, setActive] = useState<ActiveTurnState | null>(null);
  const [errorText, setErrorText] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef(0);

  useInput((char, key) => {
    if (phase === "input") {
      if (key.return && !key.shift) {
        if (buffer.trim().length === 0) return;
        startTurn(buffer);
        return;
      }
      if (key.return && key.shift) {
        setBuffer((s) => s + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((s) => s.slice(0, -1));
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        setBuffer((s) => s + char);
      }
      return;
    }
    if (phase === "streaming" && key.escape) {
      abortRef.current?.abort();
    }
  });

  // Register Ink-aware shutdown steps. The top-level signal handlers
  // (installed in the bootstrap before render()) drive cleanup; this
  // mount-time hook just hands them the abort + exit functions.
  useEffect(() => {
    onShutdown(() => {
      abortRef.current?.abort();
    });
    onShutdown(async () => {
      // Give Ink a frame to render the final state before exiting
      exit();
      await new Promise((r) => setTimeout(r, 50));
    });
  }, [exit]);

  useEffect(() => {
    if (phase !== "streaming" || active === null) return;
    const startedAt = active.startedAt;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, [phase, active]);

  function startTurn(userText: string) {
    setBuffer("");
    const startedAt = Date.now();
    let cur: ActiveTurnState = {
      userText,
      reasoning: "",
      text: "",
      toolCalls: [],
      currentRound: 0,
      startedAt,
    };
    setActive(cur);
    setPhase("streaming");
    setElapsedMs(0);

    const abort = new AbortController();
    abortRef.current = abort;

    void (async () => {
      try {
        for await (const ev of loop.runTurn(userText, { signal: abort.signal })) {
          cur = applyEvent(cur, ev);
          if (ev.type === "turn_complete") {
            const completedTurn: CompletedTurn = {
              id: ++turnIdRef.current,
              userText,
              reasoning: cur.reasoning,
              text: cur.text,
              toolCalls: cur.toolCalls,
              doneReason: ev.reason,
              doneSummary: ev.summary,
              errorMessage: ev.errorMessage,
            };
            setCompleted((c) => [...c, completedTurn]);
            setActive(null);
            if (ev.reason === "error") {
              setErrorText(ev.errorMessage ?? "(unknown)");
              setPhase("input"); // recoverable — user can try another prompt
            } else {
              setPhase("input");
            }
            abortRef.current = null;
            return;
          }
          // Push the live state to React so the UI re-renders
          setActive({ ...cur });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
        setErrorText(msg);
        setPhase("error");
      }
    })();
  }

  return (
    <Box flexDirection="column">
      {completed.length === 0 && active === null && (
        <Box marginBottom={1} flexDirection="column">
          <Text bold color="cyan">DevMindShell</Text>
          {banner.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
          <Text dimColor>tools:       {toolsCount} available</Text>
        </Box>
      )}

      <Static items={completed}>
        {(turn) => <CompletedTurnView key={turn.id} turn={turn} />}
      </Static>

      {active !== null && <ActiveTurn turn={active} />}

      {phase === "error" && (
        <Box marginBottom={1}>
          <Text color="red">ERROR: {errorText}</Text>
        </Box>
      )}

      <InputBox buffer={buffer} active={phase === "input"} />
      <StatusBar phase={phase} active={active} elapsedMs={elapsedMs} toolsCount={toolsCount} />
    </Box>
  );
}

// Pure: apply a LoopEvent to the active turn state, returning a new state.
function applyEvent(turn: ActiveTurnState, ev: LoopEvent): ActiveTurnState {
  switch (ev.type) {
    case "round_started":
      return { ...turn, currentRound: ev.round };
    case "reasoning_delta":
      return { ...turn, reasoning: turn.reasoning + ev.delta };
    case "text_delta":
      return { ...turn, text: turn.text + ev.delta };
    case "tool_call_dispatch": {
      const entry: ToolCallEntry = {
        id: ev.id,
        name: ev.name,
        args: ev.args,
        result: null,
        isError: null,
        progress: [],
        status: PROGRESS_TOOLS.has(ev.name) ? "running" : "dispatching",
      };
      return { ...turn, toolCalls: [...turn.toolCalls, entry] };
    }
    case "tool_call_progress": {
      const calls = turn.toolCalls.map((c) =>
        c.id === ev.id ? { ...c, progress: [...c.progress, ev.line] } : c,
      );
      return { ...turn, toolCalls: calls };
    }
    case "tool_call_result": {
      const calls = turn.toolCalls.map((c) =>
        c.id === ev.id ? { ...c, result: ev.result, isError: ev.isError, status: "done" as const } : c,
      );
      return { ...turn, toolCalls: calls };
    }
    case "context_trim":
      // No active-turn UI surface in Phase D — just keep going. The trim
      // happens before the user message goes in, and it's diagnostic.
      // (A future banner notification could surface this.)
      return turn;
    case "turn_complete":
      return turn;
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

// Install signal handlers BEFORE any work — even McpServer connect can
// hang and the user might want to Ctrl+C out of it.
installSignalHandlers();

let config: ReturnType<typeof resolveConfig>;
try {
  config = resolveConfig();
} catch (e: unknown) {
  process.stderr.write(
    `Configuration error:\n${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
}

const cwd = process.cwd();
const mcp = new McpClient();

// McpServer disconnect runs late in the shutdown sequence so any active
// tool calls get a chance to abort first.
onShutdown(async () => {
  await mcp.disconnect();
});

let tools: ToolInfo[];
try {
  await mcp.connect(config.mcpServerPath, cwd);
  tools = await mcp.listTools();
} catch (e: unknown) {
  process.stderr.write(
    `Failed to connect to McpServer at ${config.mcpServerPath}\n` +
      `Working directory: ${cwd}\n` +
      `Error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}

const streaming = new StreamingClient({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  model: config.model,
});

const projectContext = loadProjectContext(cwd);
const SYSTEM_PROMPT =
  `You are DevMindShell, a coding assistant running in a terminal. ` +
  `Working directory: ${cwd.replace(/\\/g, "/")}. ` +
  `You have ${tools.length} tools available; use them to read, search, and modify files in the working directory. ` +
  `When you have completed the user's task, call task_done with a brief summary. ` +
  `Always read files before patching them. Use list_files or find_in_files for discovery — never assume a path.` +
  formatContextForPrompt(projectContext);

const loop = new AgenticLoop({
  streaming,
  mcp,
  mcpTools: tools,
  systemPrompt: SYSTEM_PROMPT,
  toolTimeoutMs: config.toolTimeoutMs,
});

const banner = describeConfig(config).split("\n");
if (projectContext.length > 0) {
  banner.push(
    `context:     ${projectContext
      .map((f, i) => (i === 0 ? f.filename : `+${f.filename}`))
      .join(", ")}`,
  );
} else {
  banner.push(`context:     (no DevMind.md / CLAUDE.md / AGENTS.md found in cwd)`);
}
const { waitUntilExit } = render(
  <App loop={loop} toolsCount={tools.length} banner={banner} />,
);
await waitUntilExit();
// Normal Ink exit path: run shutdown steps too (so McpServer disconnects).
await mcp.disconnect().catch(() => {});
process.exit(0);
