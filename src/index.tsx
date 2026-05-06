// File: src/index.tsx  v4.3
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
import { resolveConfig, describeConfig, type Config } from "./util/config.js";
import { loadProjectContext, type LoadedContextFile } from "./util/projectContext.js";
import { assembleSystemPrompt } from "./util/systemPrompt.js";
import { probeLlamaServer, writeStartupError } from "./util/startup.js";
import { theme } from "./ui/theme.js";
import {
  dispatchSlashCommand,
  isSlashCommand,
  type CommandContext,
} from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/builtins.js";

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

type CompletedAgenticTurn = {
  kind: "agentic";
  id: number;
  userText: string;
  reasoning: string;
  text: string;
  toolCalls: ToolCallEntry[];
  doneReason: string;
  doneSummary: string | undefined;
  errorMessage: string | undefined;
};

type CompletedCommandTurn = {
  kind: "command";
  id: number;
  userText: string;
  resultText: string;
  isError: boolean;
};

type CompletedTurn = CompletedAgenticTurn | CompletedCommandTurn;

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
  showReasoning,
}: {
  text: string;
  expanded: boolean;
  streaming: boolean;
  showReasoning: boolean;
}) {
  if (!showReasoning || text.length === 0) return null;
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
    call.status === "done" ? (call.isError ? theme.error : theme.success) : theme.pending;
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
          <Text color={call.isError ? theme.error : theme.input}>{"  [← "}</Text>
          <Text>{summarizeResult(call.result, call.isError === true)}</Text>
          <Text color={call.isError ? theme.error : theme.input}>{"]"}</Text>
        </Text>
      )}
    </Box>
  );
}

function CompletedAgenticTurnView({ turn, showReasoning }: { turn: CompletedAgenticTurn; showReasoning: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.input}>{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <ReasoningBlock text={turn.reasoning} expanded={false} streaming={false} showReasoning={showReasoning} />
      {turn.text.length > 0 && <Text>{turn.text}</Text>}
      {turn.toolCalls.map((c) => (
        <ToolCallView key={c.id} call={c} isActive={false} />
      ))}
      {turn.doneReason === "task_done" && turn.doneSummary && (
        <Text color={theme.success}>✓ {turn.doneSummary}</Text>
      )}
      {turn.doneReason === "abort" && <Text color={theme.pending}>[cancelled]</Text>}
      {turn.doneReason === "error" && turn.errorMessage && (
        <Text color={theme.error}>✗ {turn.errorMessage}</Text>
      )}
      {turn.doneReason === "depth_cap" && turn.errorMessage && (
        <Text color={theme.error}>✗ {turn.errorMessage}</Text>
      )}
    </Box>
  );
}

function CompletedCommandTurnView({ turn }: { turn: CompletedCommandTurn }) {
  // Slash-command result. Echo the typed command, then the result body.
  // Errors render in red; successes in normal foreground. No reasoning,
  // no tool calls, no done markers — commands are local-only operations.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.input}>{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <Text color={turn.isError ? theme.error : theme.normal}>{turn.resultText}</Text>
    </Box>
  );
}

function CompletedTurnView({ turn, showReasoning }: { turn: CompletedTurn; showReasoning: boolean }) {
  if (turn.kind === "command") {
    return <CompletedCommandTurnView turn={turn} />;
  }
  return <CompletedAgenticTurnView turn={turn} showReasoning={showReasoning} />;
}

function ActiveTurn({ turn, showReasoning }: { turn: ActiveTurnState; showReasoning: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.input}>{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <ReasoningBlock
        text={turn.reasoning}
        expanded={true}
        streaming={turn.text.length === 0 && turn.toolCalls.length === 0}
        showReasoning={showReasoning}
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
      borderColor={active ? theme.input : theme.dim}
      paddingX={1}
    >
      {lines.map((line, i) => (
        <Box key={i}>
          {i === 0 ? <Text color={theme.input}>{"> "}</Text> : <Text>{"  "}</Text>}
          <Text>{line}</Text>
          {active && i === lines.length - 1 && <Text color={theme.dim}>▌</Text>}
        </Box>
      ))}
    </Box>
  );
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color={theme.normal}>{BRAILLE_FRAMES[frame]}</Text>;
}

function StatusBar({
  phase,
  active,
  elapsedMs,
  toolsCount,
  showReasoning,
}: {
  phase: Phase;
  active: ActiveTurnState | null;
  elapsedMs: number;
  toolsCount: number;
  showReasoning: boolean;
}) {
  if (phase === "streaming" && active) {
    const lastCall = active.toolCalls[active.toolCalls.length - 1];
    const inToolDispatch = lastCall && lastCall.status !== "done";
    if (inToolDispatch && lastCall) {
      return (
        <Text>
          <Spinner /><Text color={theme.pending}> Running: </Text>
          <Text>{lastCall.name}</Text>
          <Text dimColor>
            {" "}({(elapsedMs / 1000).toFixed(1)}s, round {active.currentRound})  [Esc to cancel]
          </Text>
        </Text>
      );
    }
    // Reasoning phase: reasoning tokens arriving, no content or tool calls yet.
    const isReasoningPhase =
      active.reasoning.length > 0 &&
      active.text.length === 0 &&
      active.toolCalls.length === 0;
    if (!showReasoning && isReasoningPhase) {
      return (
        <Text>
          <Spinner />{" "}<Text color={theme.thinkingActive}>Thinking...</Text>
        </Text>
      );
    }
    return (
      <Text>
        <Spinner /><Text color={theme.pending}> Generating... </Text>
        <Text dimColor>
          ({(elapsedMs / 1000).toFixed(1)}s, round {active.currentRound})  [Esc to cancel]
        </Text>
      </Text>
    );
  }
  if (phase === "error") {
    return <Text color={theme.error}>✗ Error</Text>;
  }
  return (
    <Text>
      <Text color={theme.success}>○ Ready </Text>
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
  initialConfig,
  cwd,
  projectContext,
}: {
  loop: AgenticLoop;
  toolsCount: number;
  banner: string[];
  initialConfig: Config;
  cwd: string;
  projectContext: LoadedContextFile[];
}) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("input");
  const [buffer, setBuffer] = useState<string>("");
  const [completed, setCompleted] = useState<CompletedTurn[]>([]);
  const [active, setActive] = useState<ActiveTurnState | null>(null);
  const [errorText, setErrorText] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState(0);
  // Runtime config state. Slash commands mutate this via setConfig in
  // the CommandContext; persistence to shell.json happens inside the
  // handler. See src/commands/builtins.ts.
  const [config, setConfig] = useState<Config>(initialConfig);
  // Latest config in a ref so closures (startTurn, command context) read
  // the current value without re-binding. React state alone would close
  // over a stale config inside the async runTurn loop.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef(0);

  useInput((char, key) => {
    if (phase === "input") {
      if (key.return && !key.shift) {
        const text = buffer.trim();
        if (text.length === 0) return;
        if (isSlashCommand(text)) {
          void runSlashCommand(text);
          return;
        }
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
    // Capture the current depthCap at the moment the turn starts. Mutations
    // mid-turn don't change the in-flight cap (matches the user's mental
    // model: setting a cap should affect the next turn, not the running one).
    const depthCap = configRef.current.depthCap;

    void (async () => {
      try {
        for await (const ev of loop.runTurn(userText, { signal: abort.signal, depthCap })) {
          cur = applyEvent(cur, ev);
          if (ev.type === "turn_complete") {
            const completedTurn: CompletedAgenticTurn = {
              kind: "agentic",
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

  async function runSlashCommand(userText: string) {
    setBuffer("");
    // Build the command context at dispatch time so handlers see live
    // state. setConfig writes through to React; resetConversation clears
    // both the rendered turn list and the loop's internal message array.
    const ctx: CommandContext = {
      config: configRef.current,
      setConfig: (next) => {
        configRef.current = next;
        setConfig(next);
      },
      resetConversation: () => {
        setCompleted([]);
        loop.resetHistory();
      },
      getSystemPrompt: () =>
        assembleSystemPrompt({
          cwd,
          toolCount: toolsCount,
          config: configRef.current,
          projectContext,
        }),
    };
    const result = await dispatchSlashCommand(userText, ctx);
    const completedTurn: CompletedCommandTurn = {
      kind: "command",
      id: ++turnIdRef.current,
      userText,
      resultText: result.message,
      isError: result.isError === true,
    };
    setCompleted((c) => [...c, completedTurn]);
  }

  return (
    <Box flexDirection="column">
      {completed.length === 0 && active === null && (
        <Box marginBottom={1} flexDirection="column">
          <Text bold color={theme.input}>DevMindShell</Text>
          {banner.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
          <Text dimColor>tools:       {toolsCount} available</Text>
        </Box>
      )}

      <Static items={completed}>
        {(turn) => <CompletedTurnView key={turn.id} turn={turn} showReasoning={config.showReasoning} />}
      </Static>

      {active !== null && <ActiveTurn turn={active} showReasoning={config.showReasoning} />}

      {phase === "error" && (
        <Box marginBottom={1}>
          <Text color={theme.error}>ERROR: {errorText}</Text>
        </Box>
      )}

      <InputBox buffer={buffer} active={phase === "input"} />
      <StatusBar phase={phase} active={active} elapsedMs={elapsedMs} toolsCount={toolsCount} showReasoning={config.showReasoning} />
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
  writeStartupError("Configuration error", [
    e instanceof Error ? e.message : String(e),
  ]);
  process.exit(2);
}

// Pre-flight: llama-server reachability. Don't abort on failure — the
// user might know the server is starting up — but warn loudly so they
// see it before the first turn fails.
const llamaErr = await probeLlamaServer(config.baseURL);
if (llamaErr !== null) {
  writeStartupError("llama-server probe failed (continuing)", [
    llamaErr,
    "",
    "DevMindShell will continue starting, but the first LLM turn will fail",
    "until the server is reachable. Check that ik_llama.cpp is running and",
    "DEVMIND_BASE_URL points at the right endpoint.",
    `Current endpoint: ${config.baseURL}`,
  ]);
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
  writeStartupError("Failed to connect to McpServer", [
    `path: ${config.mcpServerPath}`,
    `cwd:  ${cwd}`,
    "",
    e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e),
    "",
    "Verify the McpServer.exe path resolves correctly:",
    "  - Set DEVMIND_MCP_SERVER_PATH=<absolute path>",
    "  - Or build the DevMind sibling repo (Release or Debug, net8.0)",
  ]);
  process.exit(1);
}

const streaming = new StreamingClient({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  model: config.model,
});

const projectContext = loadProjectContext(cwd);
// Initial system prompt assembly. Slash commands that mutate config
// (e.g. /reasoning) do not currently affect any system-prompt-bearing
// field, so the loop's captured prompt remains correct for the session.
// /system_prompt re-assembles fresh from runtime config on every call,
// independent of this snapshot.
const SYSTEM_PROMPT = assembleSystemPrompt({
  cwd,
  toolCount: tools.length,
  config,
  projectContext,
});

// Register the five built-in slash commands with the registry. Idempotent.
registerBuiltinCommands();

const loop = new AgenticLoop({
  streaming,
  mcp,
  mcpTools: tools,
  systemPrompt: SYSTEM_PROMPT,
  toolTimeoutMs: config.toolTimeoutMs,
  depthCap: config.depthCap,
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
  <App
    loop={loop}
    toolsCount={tools.length}
    banner={banner}
    initialConfig={config}
    cwd={cwd}
    projectContext={projectContext}
  />,
);
await waitUntilExit();
// Normal Ink exit path: run shutdown steps too (so McpServer disconnects).
await mcp.disconnect().catch(() => {});
process.exit(0);
