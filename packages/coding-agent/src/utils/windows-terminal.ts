/**
 * Windows shells that cannot host the interactive UI.
 *
 * MinTTY (the Git Bash terminal) does not allocate a Windows console for its
 * children, so `process.stdin.isTTY` is false and the CLI falls back to print
 * mode with no explanation. Git Bash is a shell many Windows users already have,
 * so the CLI says why instead of appearing to ignore the request for a UI.
 */

export interface MsysEnvironment {
	[key: string]: string | undefined;
}

/**
 * Returns a hint when the current Windows terminal cannot host the interactive UI,
 * or undefined when the terminal is fine (or when this is not Windows).
 */
export function windowsTerminalHint(
	environment: MsysEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform !== "win32") {
		return undefined;
	}
	const msys = environment.MSYSTEM?.trim();
	const cygwin = environment.CYGWIN?.trim();
	const mintty = /mintty/i.test(environment.TERM_PROGRAM ?? "");
	if (!msys && !cygwin && !mintty) {
		return undefined;
	}
	const terminal = mintty ? "MinTTY" : (cygwin ?? msys);
	return (
		`Prime Agent: ${terminal} does not provide a Windows console, so the interactive UI is unavailable and this run continues in print mode. ` +
		"Use Windows Terminal or PowerShell for the interactive UI, or pass -p to keep print mode."
	);
}
