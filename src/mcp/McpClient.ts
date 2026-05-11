// File: src/mcp/McpClient.ts  v2.1
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Thin wrapper around the MCP SDK Client + StdioClientTransport. Spawns
// DevMind.McpServer.exe and communicates over stdio.
//
// Environment Setup:
// We merge the SDK's default environment with the parent process.env.
// Spreading process.env is critical on Windows to ensure that essential
// variables (like PATHEXT and COMSPEC) are passed to the server. Without
// these, grandchild processes (e.g., .exe files spawned via run_shell) may
// fail to execute or lose their output streams.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toSubprocessPath } from "../util/path.js";
import { traceEvent, traceRunId } from "../util/trace.js";
import { resolveConfig } from "../util/config.js";

const REDACT_PATTERNS: RegExp[] = [
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^OPENROUTER_/i,
];

function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = REDACT_PATTERNS.some((rx) => rx.test(k)) ? "[REDACTED]" : v;
  }
  return out;
}

let _callSeq = 0;

function nextCallId(): string {
  _callSeq += 1;
  return `${traceRunId()}-${_callSeq}`;
}

export type ToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: unknown };

export type ToolResult = {
  content: ContentItem[];
  isError?: boolean;
};

export class McpClient {
  private _client: Client | null = null;
  private _serverPath: string | null = null;
  private _workingDir: string | null = null;

  async connect(serverPath: string, workingDir: string): Promise<void> {
    this._serverPath = serverPath;
    this._workingDir = workingDir;

    const cfg = resolveConfig();
    const runId = traceRunId();

    const parentEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") parentEnv[k] = v;
    }

    const childEnv: Record<string, string> = {
      ...getDefaultEnvironment(),
      ...parentEnv,
    };

    if (cfg.traceEnabled) {
      childEnv.DEVMIND_TRACE_RUN_ID = runId;
      childEnv.DEVMIND_TRACE_ENABLED = "true";
      childEnv.DEVMIND_TRACE_DIR = cfg.traceDir;
      childEnv.DEVMIND_TRACE_LEVEL = cfg.traceLevel;
    }

    const transportArgs = ["--dir", toSubprocessPath(workingDir)];
    const transport = new StdioClientTransport({
      command: serverPath,
      args: transportArgs,
      env: childEnv,
      stderr: "inherit",
    });

    traceEvent("info", "mcp.spawn", {
      command: serverPath,
      args: transportArgs,
      cwd: workingDir,
      env_keys: Object.keys(childEnv).sort(),
    });

    traceEvent("debug", "mcp.spawn.env", {
      env: redactEnv(childEnv),
    });

    this._client = new Client(
      { name: "devmind-shell", version: "0.1.0" },
      { capabilities: {} },
    );

    await this._client.connect(transport);
  }

  /**
   * Re-establish the connection from scratch.
   * If workingDir is provided, it updates the client's working directory before reconnecting.
   * Used by §9.3 crash recovery and /dir command.
   */
  async reconnect(workingDir?: string): Promise<void> {
    if (!this._serverPath) {
      throw new Error("McpClient.reconnect: never connected; call connect() first");
    }
    if (workingDir) {
      this._workingDir = workingDir;
    }
    if (!this._workingDir) {
      throw new Error("McpClient.reconnect: never connected; call connect() first");
    }
    try {
      await this._client?.close();
    } catch {
      // ignore — old client may already be torn down
    }
    this._client = null;
    await this.connect(this._serverPath, this._workingDir);
  }

  async listTools(): Promise<ToolInfo[]> {
    const callId = nextCallId();
    const startedAt = Date.now();

    traceEvent("info", "mcp.list_tools.request", {
      call_id: callId,
    });

    try {
      const result = await this._assertClient().listTools();
      const mapped = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));

      traceEvent("info", "mcp.list_tools.response", {
        call_id: callId,
        outcome: "ok",
        duration_ms: Date.now() - startedAt,
        tool_count: mapped.length,
        tools: mapped,
      });

      return mapped;
    } catch (e) {
      traceEvent("info", "mcp.list_tools.response", {
        call_id: callId,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
        error_class: e instanceof Error ? e.constructor.name : "unknown",
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  /**
   * Call a tool. If onProgressLine is set, the SDK's onprogress callback
   * (protocol.d.ts:67) is wired to forward each line to it. The C# server's
   * ProgressNotificationValue.Message field carries one shell-output line per
   * notification; we re-expose that as a clean per-line stream.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { onProgressLine?: (line: string) => void; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const callId = nextCallId();
    const startedAt = Date.now();

    traceEvent("info", "mcp.tool_call.request", {
      call_id: callId,
      tool: name,
      args,
      timeout_ms: opts.timeoutMs ?? null,
      has_progress_callback: opts.onProgressLine !== undefined,
    });

    // Always wire a progress handler so we can trace every notification.
    // Forward to the caller's callback only if one was provided.
    const wrappedOnProgress = (progress: { message?: unknown }) => {
      if (typeof progress.message === "string" && progress.message.length > 0) {
        traceEvent("debug", "mcp.tool_call.progress", {
          call_id: callId,
          tool: name,
          line: progress.message,
        });
        if (opts.onProgressLine) {
          opts.onProgressLine(progress.message);
        }
      }
    };

    try {
      const result = await this._assertClient().callTool(
        { name, arguments: args },
        undefined,
        {
          signal: opts.signal,
          timeout: opts.timeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: wrappedOnProgress,
        },
      );

      const out: ToolResult = {
        content: result.content as ContentItem[],
        isError: result.isError as boolean | undefined,
      };

      traceEvent("info", "mcp.tool_call.response", {
        call_id: callId,
        tool: name,
        outcome: "ok",
        duration_ms: Date.now() - startedAt,
        is_error: out.isError ?? false,
        content: out.content,
      });

      return out;
    } catch (e) {
      traceEvent("info", "mcp.tool_call.response", {
        call_id: callId,
        tool: name,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
        error_class: e instanceof Error ? e.constructor.name : "unknown",
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this._client?.close();
    this._client = null;
  }

  private _assertClient(): Client {
    if (!this._client) throw new Error("McpClient: not connected — call connect() first");
    return this._client;
  }
}
