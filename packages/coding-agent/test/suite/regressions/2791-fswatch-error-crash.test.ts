import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";

// `execFileSync("npx", ...)` cannot start on Windows: npx is a .cmd shim, which a
// direct spawn without a shell does not resolve (ENOENT), and the swallowed spawn
// error looked like "child crashed (exit 1)". Launch the same TypeScript loader
// every other suite fixture uses, through the current Node binary.
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * We test this by spawning a child process that:
 * 1. Sets up a custom theme with the watcher enabled
 * 2. Finds the FSWatcher via process._getActiveHandles()
 * 3. Emits a synthetic 'error' event on it
 * 4. If the watcher has no error handler -> crash (exit != 0) -> bug present
 * 5. If the watcher has an error handler -> clean exit (exit 0) -> bug fixed
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		// Copy dark.json as "custom-test" theme
		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		// The generated module imports the theme by specifier: a bare absolute
		// Windows path is rejected by the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME),
		// while a file URL is valid everywhere and still resolves to the TypeScript
		// source through tsx.
		const themeModuleUrl = pathToFileURL(join(__dirname, "../../../src/modes/interactive/theme/theme.js")).href;
		const agentDir = join(tempRoot, "agent").replace(/\\/g, "/");

		// Script that sets up the watcher and emits a synthetic error on it.
		// If no .on('error') handler is attached, EventEmitter.emit('error')
		// throws, which either crashes the process or gets caught by our try/catch.
		const scriptPath = join(tempRoot, "test-watcher-error.mts");
		writeFileSync(
			scriptPath,
			`
import { setTheme, stopThemeWatcher } from ${JSON.stringify(themeModuleUrl)};

process.env[${JSON.stringify(ENV_AGENT_DIR)}] = ${JSON.stringify(agentDir)};

setTheme("custom-test", true);

// Find the FSWatcher among active handles
const handles = (process as any)._getActiveHandles();
const fsWatcher = handles.find((h: any) => h.constructor?.name === "FSWatcher");

if (!fsWatcher) {
	process.stderr.write("no FSWatcher found among active handles\\n");
	process.exit(2);
}

const errorListenerCount = fsWatcher.listenerCount("error");
if (errorListenerCount === 0) {
	process.stderr.write("BUG: FSWatcher has no error handler (issue #2791)\\n");
}

// Emitting 'error' on an EventEmitter with no error listener throws.
// This simulates an async OS error (e.g. ReadDirectoryChangesW invalidation).
try {
	fsWatcher.emit("error", new Error("simulated OS watcher failure"));
} catch {
	process.stderr.write("error event was unhandled and threw\\n");
	process.exit(1);
}

stopThemeWatcher();
process.exit(0);
`,
		);

		let _stdout = "";
		let stderr = "";
		let exitCode: number;
		try {
			_stdout = execFileSync(process.execPath, [tsxPath, scriptPath], {
				timeout: 10000,
				encoding: "utf-8",
				env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
				stdio: ["pipe", "pipe", "pipe"],
			});
			exitCode = 0;
		} catch (err: unknown) {
			// A spawn failure has no status and no captured streams; surface its
			// message instead of reporting a bare exit 1.
			const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
			_stdout = e.stdout ?? "";
			stderr = e.stderr ?? e.message ?? "";
			exitCode = e.status ?? 1;
		}

		expect(exitCode, `Child crashed (exit ${exitCode}). stderr: ${stderr.trim()}`).toBe(0);
	});
});
