/**
 * Parse a `$VISUAL`/`$EDITOR` command into an executable plus arguments.
 *
 * A plain `split(" ")` breaks the normal Windows case, where the editor lives under
 * a path with spaces (`C:\\Program Files\\Microsoft VS Code\\Code.exe --wait`), and
 * spawning the result through a shell lets the shell re-split it, so the fix is to
 * parse quotes here and spawn the executable directly.
 *
 * Quoting rules: whitespace separates words, single and double quotes group a word,
 * and a backslash escapes the next character inside double quotes. On Windows a
 * backslash stays literal (paths), matching how CreateProcess reads an argument
 * list; an unterminated quote is treated as extending to the end of the string so a
 * half-typed value still resolves to something the user can see fail.
 */
import { spawnSync } from "node:child_process";

export interface EditorCommand {
	file: string;
	args: string[];
}

export interface EditorLaunchResult {
	status: number | null;
	error?: Error;
}

/**
 * Start `command` on `filePath`.
 *
 * The executable is spawned directly so Node quotes a path with spaces correctly.
 * Windows editors are often `.cmd` shims (`code.cmd`, `subl.cmd`) and a shim cannot
 * be spawned without a shell, so a failed direct spawn is retried through one with
 * the path quoted. The caller reports `error`/`status` to the user instead of
 * silently keeping the old text.
 */
export function launchEditor(
	command: string,
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): EditorLaunchResult {
	const parsed = parseEditorCommand(command, platform);
	if (!parsed) {
		return { status: null, error: new Error("editor command is empty") };
	}
	const direct = spawnSync(parsed.file, [...parsed.args, filePath], { stdio: "inherit" });
	if (!direct.error) {
		return { status: direct.status, error: undefined };
	}
	if (platform !== "win32") {
		return { status: direct.status, error: direct.error };
	}
	const viaShell = spawnSync(`${command} "${filePath}"`, { stdio: "inherit", shell: true });
	return { status: viaShell.status, error: viaShell.error };
}

export function parseEditorCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
): EditorCommand | undefined {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
				started = true;
				continue;
			}
			if (character === "\\" && quote === '"' && platform !== "win32" && index + 1 < command.length) {
				current += command[++index];
				started = true;
				continue;
			}
			current += character;
			started = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character as '"' | "'";
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				words.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}
	if (started) {
		words.push(current);
	}

	if (words.length === 0) {
		return undefined;
	}
	return { file: words[0], args: words.slice(1) };
}
