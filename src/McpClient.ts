// File: McpClient.ts  v1.0
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Thin wrapper around the MCP SDK Client + StdioClientTransport.
// Spawns DevMind.McpServer.exe as a child process and communicates
// over its stdin/stdout. The server's stderr is inherited (passes
// through to our stderr) so server diagnostics appear in the terminal.

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ToolInfo = {
  name: string;
  description?: string;
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

  async connect(serverPath: string, workingDir: string): Promise<void> {
    const transport = new StdioClientTransport({
      command: serverPath,
      args: ["--dir", workingDir],
      stderr: "inherit",
    });

    this._client = new Client(
      { name: "devmind-shell", version: "0.1.0" },
      { capabilities: {} },
    );

    await this._client.connect(transport);
  }

  async listTools(): Promise<ToolInfo[]> {
    const result = await this._assertClient().listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this._assertClient().callTool({ name, arguments: args });
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
