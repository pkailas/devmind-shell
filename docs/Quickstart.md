---
doc_type: quickstart
project: DevMindShell
verified_date: 2026-05-06
last_updated: 2026-05-06
revalidate_after: 2026-08-06
rag_ready: true
---

# Quickstart

## Prerequisites
- **llama-server**: Running with a model loaded (e.g., Gemma 4) at `http://127.0.0.1:1234/v1`.
- **DevMind.McpServer.exe**: Built and available on your system.
- **Bun**: Version 1.3.13 installed.

## First launch
Run the interactive shell using the following command:

```sh
bun run dev
```

If `DevMind.McpServer.exe` is not in a sibling directory, specify its path:

```sh
$env:DEVMIND_MCP_SERVER_PATH = "C:/Users/pkailas/source/repos/DevMind/DevMind.McpServer/bin/Debug/net8.0/DevMind.McpServer.exe"
```

**Success looks like**: The shell renders in the terminal, the status bar at the bottom shows `○ Ready`, and you can type a prompt.

## First useful turn
Try this prompt to verify the read-respond cycle:

`Read package.json and tell me what scripts are available.`

**What to expect**:
1. A "thinking" block appears (reasoning_content).
2. Tool calls (typically `list_files` then `read_file`) are dispatched and results display inline.
3. The assistant provides a summary of the available scripts.

## The three things to know
- **Submitting**: Press `Enter` to send your prompt; use `Shift+Enter` for a new line.
- **Canceling**: Press `Esc` to abort an in-flight stream or tool dispatch.
- **Exiting**: Press `Ctrl+C` to shut down the shell and the MCP server cleanly.

## When something goes wrong
- **McpServer not found**: Ensure `DEVMIND_MCP_SERVER_PATH` is set to the absolute path of the `.exe`.
- **llama-server unreachable**: Verify the URL is correct and `ik_llama.cpp` is running.
- **Build errors**: Run `bun run typecheck` to identify TypeScript errors.

## Where to go next
- **Full Reference**: See `README.md` for detailed configuration and environment variables.
- **User Manual**: Coming soon.
