# First Release Checklist — devmind v0.1.0

The first release establishes the pattern. Subsequent releases are just `build.ps1` -> upload.

## One-time setup

1. Confirm sibling-repo layout on your build machine:
   ```
   C:\Users\pkailas\source\repos\
   ├── devmind-shell\        (cloned; build.ps1 lives in tooling\)
   └── devmind-core\         (cloned)
   ```
   If your layout differs, pass `-ShellRepo` and `-CoreRepo` to `build.ps1`.

2. Verify prerequisites on the build machine:
   ```powershell
   bun --version       # should be 1.3.x or newer
   dotnet --version    # should be 8.0.x or newer
   ```

3. Confirm `install.ps1` is at the root of `pkailas/devmind-shell` on `main`. The installer URL the user runs is:
   ```
   https://raw.githubusercontent.com/pkailas/devmind-shell/main/install.ps1
   ```
   Until this file exists at that path, the install one-liner returns 404.

## Building the release

1. Pull latest on both source repos:
   ```powershell
   cd ..\devmind-shell ; git pull
   cd ..\devmind-core  ; git pull
   ```

2. Run the build:
   ```powershell
   cd <devmind-shell>\tooling
   .\build.ps1 -Version 0.1.0
   ```
   Output: `dist\devmind-v0.1.0-win-x64.zip`

3. Smoke test the zip on the build machine first:
   ```powershell
   $test = "$env:TEMP\devmind-smoke"
   Remove-Item -Recurse -Force $test -ErrorAction SilentlyContinue
   Expand-Archive .\dist\devmind-v0.1.0-win-x64.zip $test
   $env:DEVMIND_MCP_SERVER_PATH = "$test\DevMind.McpServer.exe"
   & "$test\devmind.exe" --help    # or whatever the help/version flag is
   ```
   If the shell starts, connects to the LLM endpoint, and lists tools, the zip is good.

4. (Optional but recommended) Test the installer on a fresh VM that does NOT have Bun or .NET installed.
   This validates the self-contained-publish claim. Snapshot the VM, install, verify, roll back.

## Publishing the release on GitHub

1. Go to https://github.com/pkailas/devmind-shell/releases/new

2. Fill out:
   - **Tag**: `v0.1.0`  (create new tag on `main`)
   - **Title**: `DevMind v0.1.0`
   - **Description**: short — what it is, link to README, link to install one-liner. Example:
     ```
     First public release. Windows x64 only.

     Install:
     ```
     iwr https://raw.githubusercontent.com/pkailas/devmind-shell/main/install.ps1 | iex
     ```

     Requires an OpenAI-compatible LLM endpoint. See README for configuration.
     ```
   - **Attach**: drag `dist\devmind-v0.1.0-win-x64.zip` into the asset uploader.
   - Leave "Pre-release" unchecked unless you want the installer to skip it (`/releases/latest` returns the latest non-prerelease only).

3. Publish.

4. Verify the install one-liner works from a clean machine:
   ```powershell
   iwr https://raw.githubusercontent.com/pkailas/devmind-shell/main/install.ps1 | iex
   ```
   Open a NEW terminal afterward — the PATH change won't show up in the terminal that ran the installer.

## Subsequent releases

1. Bump version (semver: patch for bug fixes, minor for features, major for breaking changes).
2. Run `.\build.ps1 -Version <new-version>`.
3. Create a new release on GitHub, attach the zip.
4. Done. `install.ps1` auto-finds the latest release, so no installer-side changes needed.

## If you need to fix install.ps1 itself

1. Edit `install.ps1` in `devmind-shell` repo.
2. Commit + push to `main`.
3. The change is live immediately at `raw.githubusercontent.com/.../main/install.ps1`.
   No release needed — `install.ps1` is fetched fresh on every install.

## If something goes wrong post-release

- **Yank a bad release**: GitHub release page -> ... menu -> "Delete release". The tag stays unless you also delete it via `git push origin :refs/tags/v0.1.0`. Installer will fall back to the next-newest non-prerelease.
- **Rebuild with same version**: Delete release, delete tag, rerun build, recreate release.

## Things this checklist intentionally skips

- Code signing (`signtool.exe`). Worth adding once you have a code-signing certificate, but optional for an internal/early tool. Without it, SmartScreen will show a warning the first time `devmind.exe` runs on most Windows machines.
- Antivirus pre-submission. Some AV engines flag self-contained .NET single-file binaries because malware uses the same packaging. If users hit this, submit the binary to Microsoft and the major AV vendors for whitelisting.
- Auto-update. Re-running the install one-liner upgrades to latest, which is good enough for now. A `devmind self-update` command can come later.
