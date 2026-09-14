import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, win32 } from "node:path";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";
import { spawnHidden, spawnSyncHidden } from "./child-process.js";

export type ShellKind = "posix" | "powershell" | "cmd";

export interface ShellConfig {
	shell: string;
	args: string[];
	/** Shell family: selects platform-correct command wrapping and help text. */
	kind?: ShellKind;
	/** Rewrite the user command so the process exit code reflects its outcome. */
	wrapCommand?: (command: string) => string;
}

/** System32\bash.exe is the WSL launcher (runs Linux-side), so %SystemRoot% matches are only a last resort. */
export function orderWindowsBashCandidates(matches: readonly string[], systemRoot: string | undefined): string[] {
	if (!systemRoot) return [...matches];
	const prefix = win32.join(systemRoot, "\\").toLowerCase();
	const underSystemRoot = (match: string) => win32.normalize(match).toLowerCase().startsWith(prefix);
	return [...matches.filter((match) => !underSystemRoot(match)), ...matches.filter(underSystemRoot)];
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSyncHidden("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const matches = result.stdout.trim().split(/\r?\n/).filter(Boolean);
				for (const match of orderWindowsBashCandidates(matches, process.env.SystemRoot)) {
					if (existsSync(match)) {
						return match;
					}
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSyncHidden("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/** Classify a shell by its executable name so commands can be wrapped correctly. */
export function classifyShell(shell: string): ShellKind {
	const name = win32.basename(shell).toLowerCase();
	if (name === "powershell.exe" || name === "powershell" || name === "pwsh.exe" || name === "pwsh") {
		return "powershell";
	}
	if (name === "cmd.exe" || name === "cmd") {
		return "cmd";
	}
	return "posix";
}

/**
 * PowerShell exits 0 for a failed cmdlet and reports native command failures only
 * through $LASTEXITCODE, so map the command outcome onto the process exit code the
 * tool reports.
 */
export function wrapPowerShellCommand(command: string): string {
	return `${command}\nexit $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })`;
}

function shellConfigFor(shell: string, kind: ShellKind): ShellConfig {
	if (kind === "powershell") {
		return {
			shell,
			args: ["-NoProfile", "-NonInteractive", "-Command"],
			kind,
			wrapCommand: wrapPowerShellCommand,
		};
	}
	if (kind === "cmd") {
		return { shell, args: ["/d", "/s", "/c"], kind };
	}
	return { shell, args: ["-c"], kind };
}

/**
 * Shells that ship with Windows. Windows PowerShell 5.1 is present on every
 * supported Windows version, so it is the default shell and no POSIX shell has to
 * be installed; ComSpec (cmd.exe) is the fallback.
 */
function windowsShellCandidates(): string[] {
	return [
		win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Windows PowerShell, then ComSpec (cmd.exe)
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return shellConfigFor(customShellPath, classifyShell(customShellPath));
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Windows PowerShell, then cmd.exe. Neither needs a POSIX shell.
		for (const candidate of windowsShellCandidates()) {
			if (existsSync(candidate)) {
				return shellConfigFor(candidate, "powershell");
			}
		}
		const comSpec = process.env.ComSpec?.trim() || "cmd.exe";
		return shellConfigFor(comSpec, "cmd");
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

// Literal Program Files roots: the env vars of the same name are ambient
// attacker-influenceable input, the same trust-laundering class as PATH.
const PROGRAM_FILES_ROOT = "C:\\Program Files";
const PROGRAM_FILES_X86_ROOT = "C:\\Program Files (x86)";

/**
 * Git for Windows install roots, including the per-user root that a non-elevated
 * install uses. Derived from the home directory and the two literal Program Files
 * roots, never from PATH.
 */
export function windowsGitBashCandidates(
	homeDirectory: string,
	programFiles: string | undefined,
	programFilesX86: string | undefined,
): string[] {
	const candidates: string[] = [];
	if (programFiles) {
		candidates.push(win32.join(programFiles, "Git", "bin", "bash.exe"));
	}
	if (programFilesX86) {
		candidates.push(win32.join(programFilesX86, "Git", "bin", "bash.exe"));
	}
	candidates.push(win32.join(homeDirectory, "AppData", "Local", "Programs", "Git", "bin", "bash.exe"));
	return candidates;
}

/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the literal Git Bash roots plus the
 * per-user root under the home directory, never PATH (a repo-controlled
 * PATH/where.exe must not pick the kernel shell).
 * undefined = no shell found: kernel startup must not fail, bash() raises its
 * teaching error.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	for (const path of windowsGitBashCandidates(homedir(), PROGRAM_FILES_ROOT, PROGRAM_FILES_X86_ROOT)) {
		if (existsSync(path)) {
			return path;
		}
	}
	return undefined;
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	// Agent-spawned shells never have a usable stdin (stdio: ["ignore", "pipe", "pipe"]),
	// so any interactive prompt opened via /dev/tty is a guaranteed hang until killed:
	// `git commit` without -m launches $EDITOR, credential helpers block waiting for a
	// password, pagers read the terminal directly. Make those cases fail fast or no-op
	// instead of hanging.
	//
	// These deliberately override inherited terminal settings (an EDITOR=vim inherited
	// from the launching shell is exactly the hang we are preventing, and stdin is
	// ignored even for user `!` commands, so an interactive editor can never receive
	// keystrokes anyway). A user who wants a prompt in a specific command can override
	// inline (`GIT_EDITOR=vim git commit`), which takes precedence over exported vars.
	return {
		...process.env,
		[pathKey]: updatedPath,
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_TERMINAL_PROMPTS: "0",
		GIT_ASKPASS: "true",
		SSH_ASKPASS_REQUIRE: "never",
		EDITOR: "true",
		VISUAL: "true",
		PAGER: "cat",
		GIT_PAGER: "cat",
		DEBIAN_FRONTEND: "noninteractive",
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	recordOrphanProcessState(pid, true);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	recordOrphanProcessState(pid, false);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
		recordOrphanProcessState(pid, false);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Absolute System32 taskkill with NoDefaultCurrentDirectoryInExePath: a bare
		// name could resolve an attacker-planted taskkill.exe from the CWD, and the
		// async ENOENT must not surface as an unhandled ChildProcess "error" event.
		try {
			const child = spawnHidden(
				win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
				},
			);
			child.on("error", () => {});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
