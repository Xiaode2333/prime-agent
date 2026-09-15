# Windows Setup

Prime Agent installs and runs on native Windows. WSL is not required.

Windows uses the npm release tarball route. Standalone Windows binaries are not published yet, so the compiled-install path used on macOS and Linux does not apply.

## Requirements

- Windows 10 1809 or Windows 11, x64.
- Node.js 22.8.0 or newer. `winget install --id OpenJS.NodeJS.LTS -e` installs a suitable build.

Node.js ships `npm`, so no separate package manager setup is required. No POSIX shell, Git Bash, or WSL is needed.

## Install

From PowerShell:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

From a checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Installer options:

| Option | Effect |
| --- | --- |
| `-Channel beta` | Install the beta channel instead of stable. |
| `-Version 0.9.4` | Install a specific version. |
| `-BaseUrl <url>` | Use another release base URL. |
| `-NpmPrefix <dir>` | Install into a specific npm global prefix. |
| `-SkipKernel` | Skip install-time Python kernel preparation. |
| `-SkipUv` | Do not install uv; pair this with `PRIME_AGENT_KERNEL_PYTHON`. |
| `-SkipPath` | Do not change the user `PATH`. |

The installer:

1. Checks that Node.js is 22.8.0 or newer and locates `npm`.
2. Resolves the release version from the selected channel.
3. Downloads `prime-agent-<version>.tgz` and verifies its SHA-256 against the release manifest.
4. Installs the tarball globally with `npm install -g`.
5. Installs [uv](https://docs.astral.sh/uv/) when it is missing, because the Python kernel needs it once.
6. Adds the npm global prefix to the user `PATH` when it is absent.

Open a new terminal after the install so the updated `PATH` applies.

## First Run

```powershell
cd C:\path\to\project
prime-agent
```

Run `/login` on first launch to choose a subscription or API-key provider, or set an environment variable such as `ANTHROPIC_API_KEY` before launch.

The first launch prepares the Python kernel. This takes about 30 seconds and needs network access; later launches are offline.

## Shell

Prime Agent runs shell commands through Windows PowerShell, which ships with every
supported Windows version. Git for Windows is not required, and Prime Agent never
uses the bash shell.

Resolution order for the shell used by the `bash` tool:

1. `shellPath` from `~/.prime/agent/settings.json`
2. Windows PowerShell
   (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`)
3. `ComSpec` (`cmd.exe`)

Commands run as `powershell -NoProfile -NonInteractive -Command <command>`. The tool
appends an exit-code mapping so a native command failure, such as `cmd /c exit 42`,
is reported as exit code 42 rather than as a successful PowerShell run. A failing
cmdlet reports exit code 1.

Set `shellPath` to use a different shell, such as PowerShell 7:

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
}
```

Git Bash remains available through the same setting if you install it and prefer it:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

The Python kernel's `bash()` uses the same resolution order as the shell tool, so
`bash()` inside the REPL also runs on Windows PowerShell with no POSIX shell
installed. It reports the command's own exit code and keeps the same handle API
(`poll`, `tail`, `output`, `kill`). Git Bash is used only when `shellPath` points
at it, and then the kernel keeps the POSIX behaviour.

## Support Status

What works on native Windows, and what does not:

| Area | Status |
| --- | --- |
| Install, upgrade, uninstall | `install.ps1` installs the npm release tarball (`-Uninstall` removes it, `-PurgeData` also removes user data). |
| Shell tool | Windows PowerShell by default, `ComSpec` as fallback, `shellPath` as override. No POSIX shell needed. |
| Python kernel | Bootstraps with `uv` and runs; the kernel's `bash()` uses the same shell resolution as the shell tool. |
| `bash()` in the kernel | Windows PowerShell or cmd.exe, with the command's own exit code and the same handle API. |
| Background services | `prime-agent doctor`, `status`, `ps`, and `shutdown --force` see and stop daemons through the supervisor-owner registry. |
| Secrets and state | `%USERPROFILE%\.prime` is ACL-hardened on startup (inheritance removed, owner-only grant); a new file inherits the restriction. |
| Compiled standalone binaries | Not published for Windows. The npm tarball route is the supported install. |
| Native self-update | Not applicable without a standalone build. Update by re-running `install.ps1`, which resolves the latest stable release. |
| `shellPath` for gates | Autonomous quality gates follow the same shell resolution as the shell tool, but do not read `shellPath` yet. |

## Closing the Terminal

A Windows console gives a process no catchable signal when its window closes, so a
`prime-agent` running in that window is terminated without running its teardown. Its
sessions and kernel state are preserved through the incremental snapshots it writes while
it works.

To stop cleanly, either exit the interactive UI from inside it, or stop the background
service from another terminal:

```powershell
prime-agent shutdown --force
```

That stops every agent, worker, and daemon, and it is also what frees the native modules
that otherwise make `npm uninstall -g prime-agent` fail with `EBUSY`.

## Troubleshooting

- `prime-agent` is not recognized after install: open a new terminal, or run `$env:Path = "$env:APPDATA\npm;$env:Path"` for the current session.
- The kernel reports that uv is missing: install it with `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"`, or set `PRIME_AGENT_KERNEL_PYTHON` to an interpreter that already has `prime-agent-runtime` installed.
- `npm install`, `npm ci`, or `npm uninstall` fails with `EBUSY`, `EPERM`, or a locked `*.node` file: a process still holds the native module. A running daemon is the usual cause, and a leftover build or test process is the other. Stop the daemon first, then retry:

  ```powershell
  prime-agent shutdown --force
  ```

  Then re-run the command. The installer retries this class of failure automatically for its own install step.
- Calling `prime-agent` from inside a `.cmd` or `.bat` script never returns: invoking another batch file without `call` transfers control to it permanently, so the script stops at that line. Use `call prime-agent ...` instead:

  ```bat
  call prime-agent --version
  ```

- Background service problems: `prime-agent doctor` inspects state, and `prime-agent doctor --fix` repairs it. On Windows the list comes from the supervisor-owner registry, so a live daemon whose identity cannot be confirmed is reported as `unverified` rather than omitted.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

That stops the background service first, so the daemon does not hold native modules open while npm removes them, then removes the global package. Session history and configuration stay in `%USERPROFILE%\.prime`.

To remove the data as well — sessions, settings, the Python kernel virtual environment, and the uv binaries prime-agent installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -PurgeData
```

Without a checkout, the equivalent manual commands are `prime-agent shutdown --force` followed by `npm uninstall -g prime-agent`.
