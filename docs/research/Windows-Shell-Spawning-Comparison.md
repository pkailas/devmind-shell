---
title: Windows Shell Spawning — Comparative Research
project: DevMindShell
tags: [windows, subprocess, shell, research]
last_updated: 2026-05-06
---

# Windows Shell Spawning — Comparative Research

Research question: how do sst/opencode and ruvnet/open-claude-code handle Windows subprocess
spawning, particularly `.cmd` shim files? Does their approach inform our conservative fix for
`run_build` console-window flash and broken stdio capture?

Clones at `C:/temp/opencode` and `C:/temp/open-claude-code`. Both read-only.

---

## 1. sst/opencode

### Files implementing shell execution

Three files compose the shell pipeline:

| File | Role |
|------|------|
| `packages/opencode/src/tool/shell.ts` | LLM tool — parses user command, runs permission checks, calls spawner |
| `packages/opencode/src/shell/shell.ts` | Shell resolution — finds shells on the system, provides `ps()`, `killTree()` |
| `packages/core/src/cross-spawn-spawner.ts` | Low-level spawner — translates Effect `ChildProcess.Command` to Node.js `child_process` |

### Windows-specific handling

#### `tool/shell.ts` — `cmd()` function (lines 290–307)

```typescript
function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
```

Two branches:

- **Windows + PowerShell** (`Shell.ps(shell)` is true for `powershell` and `pwsh`): spawns PS directly
  with `-NoLogo -NoProfile -NonInteractive -Command`. `detached: false` explicitly.
- **All other cases** (cmd.exe, bash, non-Windows): passes `shell` as a `shell:` option to the spawner,
  which delegates to cross-spawn (see below).

`Shell.ps()` (`shell/shell.ts`, lines 145–147):

```typescript
export function ps(file: string) {
  return meta(file)?.ps === true
}
```

`META` table (`shell/shell.ts`, lines 10–20) marks `powershell` and `pwsh` as `{ ps: true }`.

#### `shell/shell.ts` — Windows shell discovery, `win()` (lines 91–98)

```typescript
function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}
```

Priority: `pwsh` > `powershell` > git bash > `COMSPEC`/`cmd.exe`. The default Windows shell is whichever
comes first. On most developer machines that is `pwsh`.

#### `shell/shell.ts` — process tree kill (lines 28–41)

```typescript
if (process.platform === "win32") {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("exit", () => resolve())
    killer.once("error", () => resolve())
  })
  return
}
```

Same pattern as DevMind (`taskkill /F /T /PID`). The killer process itself gets `windowsHide: true`.

### The cross-spawn spawner — `.cmd` handling

`cross-spawn-spawner.ts` imports the `cross-spawn` npm package (v7.0.6 per `bun.lock`):

```typescript
import launch from "cross-spawn"   // line 26
```

All spawns go through cross-spawn:

```typescript
const proc = launch(command.command, command.args, opts)   // line 268
```

Two critical Windows options are set at the spawner level for every spawn:

**`windowsHide`** (`cross-spawn-spawner.ts`, line 378):

```typescript
windowsHide: process.platform === "win32",
```

**`"overlapped"` stdio** (`cross-spawn-spawner.ts`, lines 152–153):

```typescript
const pipe = (x: NodeChildProcess.IOType | undefined) =>
  process.platform === "win32" && x === "pipe" ? "overlapped" : x
```

On Windows, every `"pipe"` stdio is promoted to `"overlapped"`. Overlapped I/O is Windows async I/O; it
is what libuv uses internally for async reads anyway, but requesting it explicitly avoids a synchronous
fallback path in older Node versions.

### What cross-spawn does with `.cmd` files

`cross-spawn/lib/parse.js` (library source, not in the opencode repo itself):

```javascript
const isExecutableRegExp = /\.(?:com|exe)$/i;
const isCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

function parseNonShell(parsed) {
  if (!isWin) { return parsed; }

  const commandFile = detectShebang(parsed);
  const needsShell = !isExecutableRegExp.test(commandFile);

  if (parsed.options.forceShell || needsShell) {
    const needsDoubleEscapeMetaChars = isCmdShimRegExp.test(commandFile);
    parsed.command = path.normalize(parsed.command);
    parsed.command = escape.command(parsed.command);
    parsed.args = parsed.args.map((arg) => escape.argument(arg, needsDoubleEscapeMetaChars));

    const shellCommand = [parsed.command].concat(parsed.args).join(' ');
    parsed.args = ['/d', '/s', '/c', `"${shellCommand}"`];
    parsed.command = process.env.comspec || 'cmd.exe';
    parsed.options.windowsVerbatimArguments = true;
  }

  return parsed;
}
```

Any file that is not `.exe` or `.com` — including every `.cmd` shim — is rewritten to:

```
cmd.exe /d /s /c "original.cmd [args]"
```

This `cmd.exe` is the **direct child process** created by `cross-spawn`, not a grandchild spawned by an
intermediate PowerShell. Because it is the direct child:

- `windowsHide: true` (set by the spawner) applies to it.
- The `"overlapped"` pipes are its pipes; stdout/stderr are captured correctly.

Node_modules `.bin/` shims get double-escaping for cmd.exe meta-characters (`^`, `&`, `|` etc.).

### Stdio capture

```
stdin:  "ignore"
stdout: "overlapped" pipe → NodeStream.fromReadable → Stream.merge(stdout, stderr) → "all"
stderr: "overlapped" pipe → NodeStream.fromReadable → same stream
```

Streaming: `Stream.runForEach(Stream.decodeText(handle.all), chunk => ...)` accumulates chunks as they
arrive. Chunks are appended to a rolling buffer, spilled to a temp file at 1MB (`trunc.limits().maxBytes`),
and truncated at 2× that for in-memory tracking.

### Stdio and the `.cmd` problem — resolution

Because cross-spawn rewrites `.cmd` invocations to `cmd.exe /d /s /c "..."` before the process is
spawned, opencode never has a grandchild cmd.exe created by an intermediate shell. The `windowsHide`
and pipe handles apply to the actual cmd.exe instance running the command. This solves both the console
window flash and the stdio capture problem.

---

## 2. ruvnet/open-claude-code

### Files implementing shell execution

`v2/src/tools/bash.mjs` — single file, no helper modules for spawning.

### Spawn pattern (lines 52–56)

```javascript
const proc = spawn('bash', ['-c', input.command], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 0,
});
```

Background variant (lines 124–126):

```javascript
const proc = spawn('bash', ['-c', command], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
});
```

### Windows-specific handling

**None.** The executable is hard-coded to `'bash'`. There are no `process.platform` checks, no
`windowsHide`, no `COMSPEC` reference, no `.cmd` detection. On bare Windows without Git Bash or WSL on
`PATH`, every command fails with `ENOENT`.

### Stdio capture (lines 58–68)

```javascript
proc.stdout.on('data', (chunk) => {
    if (stdout.length < MAX_OUTPUT_BYTES) { stdout += chunk.toString(); }
});
proc.stderr.on('data', (chunk) => {
    if (stderr.length < MAX_OUTPUT_BYTES) { stderr += chunk.toString(); }
});
```

All-at-once accumulation in strings. No streaming to the caller; output is returned in one block when
the process closes. 1MB cap per stream. SIGTERM at timeout, SIGKILL 5 seconds later.

### Assessment

ruvnet/open-claude-code is a POSIX-only implementation. Its patterns are clean for that target
environment (timeout escalation, background job tracking, ANSI stripping) but it provides no guidance
for Windows stdio capture. Not a useful reference for the `.cmd` problem.

---

## 3. DevMind current (reference)

**`DevMind.Core/ShellRunner.cs` v1.3, lines 67–87:**

```csharp
bool usePowerShell = IsPowerShellAvailable();
string shell = usePowerShell ? "powershell.exe" : "cmd.exe";

if (usePowerShell)
    command = command.Replace(" && ", "; ");

string sanitized = SanitizeCommand(command);
string args = usePowerShell
    ? $"-NoProfile -NonInteractive -Command \"{sanitized.Replace("\"", "\\\"")}\""
    : $"/c \"{sanitized}\"";

var psi = new ProcessStartInfo(shell, args)
{
    WorkingDirectory       = WorkingDirectory,
    UseShellExecute        = false,
    RedirectStandardOutput = true,
    RedirectStandardError  = true,
    CreateNoWindow         = true,
    WindowStyle            = ProcessWindowStyle.Hidden,
};
```

When the command is e.g. `bun run build`:
1. PowerShell is spawned as PID N with `CreateNoWindow=true`.
2. PowerShell resolves `bun` → `bun.cmd` (in `node_modules/.bin/` or on PATH).
3. PowerShell internally spawns `cmd.exe` as PID N+1 to interpret the `.cmd` file.
4. PID N+1 is a grandchild; it gets a fresh console (not inheriting PID N's redirected handles).
5. `CreateNoWindow` does not propagate past the immediate child. PID N+1 gets a new visible console.
6. `OutputDataReceived` / `ErrorDataReceived` never fire for PID N+1 output.

---

## Comparison table

| Aspect | DevMind current | sst/opencode | ruvnet/open-claude-code |
|--------|----------------|--------------|------------------------|
| Shell on Windows | `powershell.exe` (or `cmd.exe` fallback) | `pwsh`/`powershell` (PS branch) or shell: option via spawner | `bash` hard-coded — fails on bare Windows |
| `.cmd` handling | **Broken**: PS spawns `cmd.exe` grandchild internally; handles not inherited | **Fixed**: cross-spawn rewrites to `cmd.exe /d /s /c "..."` as direct child before spawn | N/A |
| Stdio capture | `BeginOutputReadLine` / `BeginErrorReadLine` event callbacks — streaming | `"overlapped"` pipes → `NodeStream.fromReadable` — streaming | `stdout.on("data")` accumulation — not streaming |
| `windowsHide` / `CreateNoWindow` | `CreateNoWindow=true` + `WindowStyle.Hidden` on direct child only | `windowsHide: true` on every spawn including the cross-spawn–rewritten `cmd.exe` | Not set |
| Process tree kill | `taskkill /F /T /PID` | `taskkill /pid /f /t` with `windowsHide: true` | SIGTERM → SIGKILL (POSIX only) |
| Overlapped stdio | N/A (.NET uses async pipes natively) | Explicit `"pipe" → "overlapped"` substitution on Windows | N/A |

---

## Recommendation

**Outcome: Suggests a specific better approach.** opencode has solved this problem, and the mechanism
is identifiable down to the library call.

### Root cause confirmed

The `.cmd` grandchild problem is real and documented. opencode avoided it not by detecting `.cmd` files
themselves, but by delegating spawn to `cross-spawn`, which pre-processes the command before `child_process.spawn`
is called. The pre-processing detects any non-`.exe`/`.com` file and rewrites the entire spawn to
`cmd.exe /d /s /c "command"` as the **direct** process. `windowsHide` then applies to that cmd.exe
directly.

### The C# equivalent

DevMind does not have a `cross-spawn` equivalent; it passes the command string to PowerShell and relies
on PowerShell's own resolution. The fix is to move `.cmd` detection to the `ShellRunner` level, before
PowerShell is involved, matching what cross-spawn does.

**Proposed fix for `ShellRunner.ExecuteAsync`:**

```csharp
// Resolve the executable the command would run. If it is a .cmd shim,
// bypass PowerShell and invoke cmd.exe directly — mirroring cross-spawn's parse.js.
// PowerShell's internal cmd.exe grandchild does not inherit redirected pipe handles.
string ResolveExecutableExtension(string command)
{
    string exe = command.Split(' ')[0].Trim('"');
    // Check absolute path first
    if (File.Exists(exe)) return Path.GetExtension(exe).ToLowerInvariant();
    // Walk PATH
    foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
    {
        string candidate = Path.Combine(dir.Trim(), exe + ".cmd");
        if (File.Exists(candidate)) return ".cmd";
        string candidateExe = Path.Combine(dir.Trim(), exe + ".exe");
        if (File.Exists(candidateExe)) return ".exe";
    }
    return "";
}

string ext = ResolveExecutableExtension(command);
bool useCmd = ext == ".cmd" || ext == ".bat";
bool usePowerShell = !useCmd && IsPowerShellAvailable();

string shell = useCmd       ? "cmd.exe"        :
               usePowerShell ? "powershell.exe" : "cmd.exe";

string args = useCmd
    ? $"/d /s /c \"{sanitized}\""          // same flags cross-spawn uses
    : usePowerShell
        ? $"-NoProfile -NonInteractive -Command \"{sanitized.Replace("\"", "\\\"")}\""
        : $"/c \"{sanitized}\"";
```

`CreateNoWindow=true` on `cmd.exe` is the direct child → `windowsHide` applies → no flash → pipes are
inherited.

### Alternative: fix the detection heuristic for DevMindShell

For the immediate `run_build` failure in DevMindShell: `DetectBuildCommand()` in `DevMindTools.cs`
returns `"npm run build"` instead of `"bun run build"` because DevMindShell has neither `bun.lockb`,
`bunfig.toml`, nor `"packageManager": "bun@"`. Adding an `engines.bun` check fixes this specific case
without touching the spawn layer. `bun` itself is a native `.exe`, not a `.cmd` shim — spawning it via
PowerShell works correctly.

Both fixes are independent and worth applying. The spawn-layer fix is the general solution; the
detection fix unblocks the immediate DevMindShell use case.

---

*Repos cloned from main branch 2026-05-06. All code citations reference files in `C:/temp/opencode`
and `C:/temp/open-claude-code`. cross-spawn `parse.js` cited from published npm package v7.0.6.*
