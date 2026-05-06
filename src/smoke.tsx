// File: src/smoke.tsx  v1.1
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Phase A MCP smoke test: spawn DevMind.McpServer.exe, complete the
// initialize handshake, call list_memory_topics, disconnect, exit.
// Run with: bun run smoke
// Verifies Phase A goal #3 (MCP client connects to McpServer).

import React, { useState, useEffect } from "react";
import { render, Text, Box, useApp } from "ink";
import { McpClient } from "./mcp/McpClient.js";

const SERVER_PATH =
  "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe";

function SmokeTest({ dir }: { dir: string }) {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>(["[Shell] Starting smoke test..."]);

  useEffect(() => {
    async function run() {
      const client = new McpClient();
      try {
        await client.connect(SERVER_PATH, dir);
        setLines((l) => [...l, "[MCP] Connected"]);

        const tools = await client.listTools();
        setLines((l) => [...l, `[MCP] ${tools.length} tools available`]);

        const result = await client.callTool("list_memory_topics", {});
        const first = result.content.find((c) => c.type === "text");
        const text = first?.type === "text" ? first.text : "(no text content)";
        setLines((l) => [...l, `[Result] ${text}`]);

        await client.disconnect();
        setLines((l) => [...l, "[MCP] Disconnected"]);
      } catch (err) {
        process.stderr.write(`[Error] ${String(err)}\n`);
        process.exit(1);
      }

      // Give React one final render cycle before exiting.
      setTimeout(() => exit(), 50);
    }

    void run();
  }, []);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

// ── Parse --dir argument ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let workingDir = process.cwd();
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === "--dir") {
    workingDir = argv[i + 1] ?? workingDir;
    break;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const { waitUntilExit } = render(<SmokeTest dir={workingDir} />);
await waitUntilExit();
process.exit(0);
