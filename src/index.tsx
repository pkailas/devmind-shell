// File: src/index.tsx  v2.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Phase A interactive shell: render Ink, accept one line of user input,
// send a single non-streaming completion request to llama-server, display
// the response, exit cleanly.
//
// Verifies Phase A goal #2: minimum viable shell.
//
// Two run modes:
//   bun run dev                          — interactive (TTY only)
//   bun run dev -- --prompt "What is 2+2?"  — headless (works without TTY)
//
// LLM endpoint configuration is read from env with sensible defaults so
// no endpoint URL is hardcoded in source — see Stage11-InkShell-Discovery.md
// §10.1 (the opencode #5674 lesson).

import React, { useState, useEffect } from "react";
import { render, Text, Box, useApp, useInput } from "ink";
import { CompletionClient } from "./llm/CompletionClient.js";

const BASE_URL = process.env.DEVMIND_BASE_URL ?? "http://10.0.0.15:8080/v1";
const API_KEY = process.env.DEVMIND_API_KEY ?? "lm-studio";
const MODEL = process.env.DEVMIND_MODEL ?? "G:\\models\\GEMMA4\\google_gemma-4-31B-it-Q8_0.gguf";

type Phase = "input" | "thinking" | "done" | "error";

function Shell({ initialPrompt }: { initialPrompt: string | null }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>(initialPrompt ? "thinking" : "input");
  const [buffer, setBuffer] = useState<string>("");
  const [submittedPrompt, setSubmittedPrompt] = useState<string>(initialPrompt ?? "");
  const [response, setResponse] = useState<string>("");
  const [reasoning, setReasoning] = useState<string>("");
  const [usage, setUsage] = useState<string>("");
  const [errorText, setErrorText] = useState<string>("");

  // Interactive input — captured per-key, only enabled in input phase
  useInput(
    (char, key) => {
      if (phase !== "input") return;
      if (key.return) {
        if (buffer.trim().length === 0) return;
        setSubmittedPrompt(buffer);
        setPhase("thinking");
      } else if (key.backspace || key.delete) {
        setBuffer((s) => s.slice(0, -1));
      } else if (char && !key.ctrl && !key.meta) {
        setBuffer((s) => s + char);
      }
    },
    { isActive: phase === "input" },
  );

  // LLM round-trip — fires whenever phase enters "thinking"
  useEffect(() => {
    if (phase !== "thinking") return;
    const prompt = submittedPrompt;
    void (async () => {
      try {
        const client = new CompletionClient({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });
        const result = await client.complete([{ role: "user", content: prompt }], {
          maxTokens: 512,
          temperature: 0.0,
        });
        setResponse(result.content);
        setReasoning(result.reasoning);
        if (result.usage) {
          setUsage(
            `prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} total=${result.usage.total_tokens}`,
          );
        }
        setPhase("done");
      } catch (e: unknown) {
        setErrorText(e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
        setPhase("error");
      }
    })();
  }, [phase, submittedPrompt]);

  // Auto-exit shortly after done/error so the run is non-blocking when run headlessly
  useEffect(() => {
    if (phase !== "done" && phase !== "error") return;
    const id = setTimeout(() => exit(), 50);
    return () => clearTimeout(id);
  }, [phase, exit]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">DevMindShell — Phase A (non-streaming)</Text>
      </Box>
      <Text dimColor>
        endpoint: {BASE_URL}
      </Text>
      <Text dimColor>
        model: {MODEL}
      </Text>
      <Box marginY={1} flexDirection="column">
        {phase === "input" && (
          <Text>
            <Text color="green">{"> "}</Text>
            <Text>{buffer}</Text>
            <Text color="gray">_</Text>
          </Text>
        )}
        {phase !== "input" && (
          <Text>
            <Text color="green">{"> "}</Text>
            <Text>{submittedPrompt}</Text>
          </Text>
        )}
      </Box>
      {phase === "thinking" && <Text color="yellow">⏳ Thinking…</Text>}
      {phase === "done" && (
        <Box flexDirection="column">
          {reasoning.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor italic>[reasoning_content]</Text>
              <Text dimColor>{reasoning}</Text>
            </Box>
          )}
          <Box flexDirection="column">
            <Text bold color="white">{response || "(empty response)"}</Text>
          </Box>
          {usage && (
            <Box marginTop={1}>
              <Text dimColor>tokens: {usage}</Text>
            </Box>
          )}
        </Box>
      )}
      {phase === "error" && (
        <Text color="red">ERROR: {errorText}</Text>
      )}
    </Box>
  );
}

// ── Parse args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let promptArg: string | null = null;
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === "--prompt") {
    promptArg = argv[i + 1] ?? null;
    break;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const { waitUntilExit } = render(<Shell initialPrompt={promptArg} />);
await waitUntilExit();
process.exit(0);
