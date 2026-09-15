/**
 * Build autonomous-gate commands for the shell that actually runs them.
 *
 * `core/autonomous.ts` resolves the gate shell with `getShellConfig()`, the same
 * resolution the bash tool uses: Windows PowerShell 5.1 on Windows (cmd.exe only
 * as the fallback), bash/sh on POSIX. A gate command is therefore a command for
 * that shell, and a test that hard-codes POSIX syntax only tests POSIX.
 *
 * Quoting matters most on Windows, where a Node install sits in
 * `C:\Program Files\nodejs\node.exe`: an unquoted executable path is a parse
 * error in every Windows shell, and PowerShell additionally needs the `&` call
 * operator before a quoted path.
 */
import { getShellConfig, type ShellKind } from "../src/utils/shell.js";

/** Shell family the gate runner uses on this platform. */
export function gateShellKind(): ShellKind {
	return getShellConfig().kind ?? "posix";
}

/** Quote one argument so the given shell passes it through unchanged. */
export function quoteGateArgument(argument: string, kind: ShellKind): string {
	if (kind === "powershell") {
		// PowerShell single quotes are literal; only an embedded quote is escaped.
		return `'${argument.replace(/'/g, "''")}'`;
	}
	if (kind === "cmd") {
		// cmd.exe passes a wrapped argument through; gate scripts must not embed quotes.
		return `"${argument}"`;
	}
	return `'${argument.replace(/'/g, "'\\''")}'`;
}

/**
 * A gate command that runs `executable` with `args` in the gate shell. Every
 * argument is quoted, so a path with spaces and a script with shell
 * metacharacters both survive the shell.
 */
export function gateCommand(executable: string, args: readonly string[], kind: ShellKind = gateShellKind()): string {
	const quoted = [executable, ...args].map((argument) => quoteGateArgument(argument, kind)).join(" ");
	// PowerShell needs the call operator before a quoted executable path.
	return kind === "powershell" ? `& ${quoted}` : quoted;
}

/** A gate command that runs a Node one-liner in the gate shell. */
export function nodeGateCommand(script: string, kind?: ShellKind): string {
	return gateCommand(process.execPath, ["-e", script], kind);
}

/** A gate command that passes wherever the gate runner runs. */
export function passingGateCommand(kind?: ShellKind): string {
	return nodeGateCommand("process.exit(0)", kind);
}

/** A gate command that fails wherever the gate runner runs. */
export function failingGateCommand(kind?: ShellKind): string {
	return nodeGateCommand("console.error('gate failed'); process.exit(1)", kind);
}
