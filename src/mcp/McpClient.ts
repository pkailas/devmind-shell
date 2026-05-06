// File: src/mcp/McpClient.ts  v1.2
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Thin wrapper around the MCP SDK Client + StdioClientTransport. Spawns
// DevMind.McpServer.exe, communicates over stdio. Server stderr is
// inherited so server diagnostics surface in the terminal.
//
// v1.2 (Phase C): listTools() now exposes inputSchema for tool descriptions
// passed to openai.tools, and callTool() accepts an onProgressLine callback
// that maps MCP notifications/progress (per protocol.d.ts:67 ProgressCallback)
// to per-line callbacks. Used by run_shell / run_build / run_tests, which
// emit ProgressNotificationValue.Message once per output line in the C#
// server (DevMindTools.cs:735-741).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toSubprocessPath } from "../util/path.js";

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

    const transport = new StdioClientTransport({
      command: serverPath,
      args: ["--dir", toSubprocessPath(workingDir)],
      stderr: "inherit",
    });

    this._client = new Client(
      { name: "devmind-shell", version: "0.1.0" },
      { capabilities: {} },
    );

    await this._client.connect(transport);
  }

  /** Re-establish the connection from scratch. Used by §9.3 crash recovery. */
  async reconnect(): Promise<void> {
    if (!this._serverPath || !this._workingDir) {
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
    const result = await this._assertClient().listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
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
    const result = await this._assertClient().callTool(
      { name, arguments: args },
      undefined,
      {
        signal: opts.signal,
        timeout: opts.timeoutMs,
        resetTimeoutOnProgress: true,
        onprogress: opts.onProgressLine
          ? (progress) => {
              if (typeof progress.message === "string" && progress.message.length > 0) {
                opts.onProgressLine!(progress.message);
              }
            }
          : undefined,
      },
    );
    return {
      content: result.content as ContentItem[],
      isError: result.isError as boolean | undefined,
    };
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
