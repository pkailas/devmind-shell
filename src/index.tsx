// File: src/index.tsx  v3.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Phase B interactive shell: streaming chat with completed-turn history
// in <Static>, live <ActiveTurn> for the in-flight response, status bar
// at the bottom. Single-turn (no conversation memory between turns) per
// the Phase B scope. Tool dispatch arrives in Phase C.
//
// Component tree per discovery doc §5:
//   <Static>     — completed turns (CompletedTurn renders user + reasoning + content)
//   <ActiveTurn> — in-flight turn (StreamingText + ReasoningBlock)
//   <InputBox>   — multiline input (Shift+Enter newline; Enter submits)
//   <StatusBar>  — last in tree → appears at bottom; shows state + token count
//
// Cancel: Ctrl+C exits the app; Escape aborts the in-flight stream.
// See discovery doc §9.1 for the rationale and Phase B summary for the
// measured cancel latency.

import React, { useState, useEffect, useRef } from "react";
import { render, Text, Box, Static, useApp, useInput } from "ink";
import { StreamingClient } from "./llm/StreamingClient.js";

const BASE_URL = process.env.DEVMIND_BASE_URL ?? "http://10.0.0.15:8080/v1";
const API_KEY = process.env.DEVMIND_API_KEY ?? "lm-studio";
const MODEL = process.env.DEVMIND_MODEL ?? "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf";

// Phase B system prompt: tool-free, minimal. Phase C wires the real tool list.
const SYSTEM_PROMPT =
  "You are DevMindShell, a coding assistant running in a terminal. " +
  `Working directory: ${process.cwd().replace(/\\/g, "/")}. ` +
  "No tools are available in this phase — answer purely from the prompt.";

type Phase = "input" | "streaming" | "error";

type CompletedTurn = {
  id: number;
  userText: string;
  reasoning: string;
  content: string;
  tokenCount: number;
  cancelled: boolean;
};

type ActiveTurnState = {
  userText: string;
  reasoning: string;
  content: string;
  tokenCount: number;
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
  // Approximate token count by chars/4 — exact count is in usage chunk
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

function CompletedTurnView({ turn }: { turn: CompletedTurn }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{turn.userText}</Text>
      </Box>
      <ReasoningBlock text={turn.reasoning} expanded={false} streaming={false} />
      {turn.content.length > 0 && <Text>{turn.content}</Text>}
      {turn.cancelled && <Text color="yellow">[cancelled]</Text>}
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
      <ReasoningBlock text={turn.reasoning} expanded={true} streaming={turn.content.length === 0} />
      {turn.content.length > 0 && <Text>{turn.content}</Text>}
    </Box>
  );
}

function InputBox({ buffer, active }: { buffer: string; active: boolean }) {
  const lines = buffer.length === 0 ? [""] : buffer.split("\n");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={active ? "green" : "gray"} paddingX={1}>
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
  tokenCount,
  elapsedMs,
}: {
  phase: Phase;
  tokenCount: number;
  elapsedMs: number;
}) {
  if (phase === "streaming") {
    return (
      <Text>
        <Text color="yellow">■ Generating... </Text>
        <Text dimColor>
          ({tokenCount} tokens, {(elapsedMs / 1000).toFixed(1)}s)  [Esc to cancel]
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
      <Text dimColor>[Enter to send · Shift+Enter for newline · Ctrl+C to exit]</Text>
    </Text>
  );
}

// ── Main app ────────────────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("input");
  const [buffer, setBuffer] = useState<string>("");
  const [completed, setCompleted] = useState<CompletedTurn[]>([]);
  const [active, setActive] = useState<ActiveTurnState | null>(null);
  const [errorText, setErrorText] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef(0);

  // ── Keyboard handling ────────────────────────────────────────────────────
  useInput((char, key) => {
    if (phase === "input") {
      if (key.return && !key.shift) {
        if (buffer.trim().length === 0) return;
        startStreaming(buffer);
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
    if (phase === "streaming") {
      if (key.escape) {
        abortRef.current?.abort();
        return;
      }
    }
  });

  // Ctrl+C exits cleanly via SIGINT (process.on path — see discovery §9.1)
  useEffect(() => {
    const onSigint = () => {
      abortRef.current?.abort();
      // Brief delay so abort can settle, then exit
      setTimeout(() => exit(), 50);
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.off("SIGINT", onSigint);
    };
  }, [exit]);

  // Elapsed-time ticker during streaming
  useEffect(() => {
    if (phase !== "streaming" || active === null) return;
    const startedAt = active.startedAt;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(id);
  }, [phase, active]);

  // ── Streaming launcher ───────────────────────────────────────────────────
  function startStreaming(userText: string) {
    setBuffer("");
    const startedAt = Date.now();
    const newActive: ActiveTurnState = {
      userText,
      reasoning: "",
      content: "",
      tokenCount: 0,
      startedAt,
    };
    setActive(newActive);
    setPhase("streaming");
    setElapsedMs(0);

    const abort = new AbortController();
    abortRef.current = abort;

    void (async () => {
      const client = new StreamingClient({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });
      let reasoning = "";
      let content = "";
      let tokenCount = 0;
      let cancelled = false;
      try {
        for await (const ev of client.stream(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userText },
          ],
          { signal: abort.signal, maxTokens: 2048, temperature: 0.0 },
        )) {
          if (ev.type === "reasoning_delta") {
            reasoning += ev.delta;
            tokenCount = Math.ceil((reasoning.length + content.length) / 4);
            setActive({ ...newActive, reasoning, content, tokenCount });
          } else if (ev.type === "content_delta") {
            content += ev.delta;
            tokenCount = Math.ceil((reasoning.length + content.length) / 4);
            setActive({ ...newActive, reasoning, content, tokenCount });
          } else if (ev.type === "usage") {
            tokenCount = ev.usage.completion_tokens;
            setActive({ ...newActive, reasoning, content, tokenCount });
          } else if (ev.type === "done") {
            if (ev.finishReason === "abort") cancelled = true;
          }
        }
      } catch (e: unknown) {
        setErrorText(e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
        setPhase("error");
        return;
      }

      // Move active → completed
      const completedTurn: CompletedTurn = {
        id: ++turnIdRef.current,
        userText,
        reasoning,
        content,
        tokenCount,
        cancelled,
      };
      setCompleted((c) => [...c, completedTurn]);
      setActive(null);
      setPhase("input");
      abortRef.current = null;
    })();
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {completed.length === 0 && active === null && (
        <Box marginBottom={1} flexDirection="column">
          <Text bold color="cyan">DevMindShell — Phase B (streaming, single-turn)</Text>
          <Text dimColor>endpoint: {BASE_URL}</Text>
          <Text dimColor>model: {MODEL}</Text>
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
      <StatusBar phase={phase} tokenCount={active?.tokenCount ?? 0} elapsedMs={elapsedMs} />
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
process.exit(0);
