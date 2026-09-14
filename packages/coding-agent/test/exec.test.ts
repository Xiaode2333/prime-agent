import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand, mergeExecEnv } from "../src/core/exec.js";

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe.skipIf(process.platform === "win32")("execCommand", () => {
	it("force kills a process that ignores SIGTERM and cleans up the fallback timer", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-test-"));
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], ""); setInterval(() => {}, 1000);`,
					readyFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(readyFile);

			vi.useFakeTimers();
			controller.abort();

			await vi.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			controller.abort();
			await resultPromise;
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

describe("mergeExecEnv", () => {
	const KEY = "PRIME_EXEC_TEST_CASE";
	const LOWER = KEY.toLowerCase();

	function withInheritedKey<T>(value: string, run: () => T): T {
		const previous = process.env[LOWER];
		process.env[LOWER] = value;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env[LOWER];
			else process.env[LOWER] = previous;
		}
	}

	function matchingKeys(env: NodeJS.ProcessEnv | undefined): string[] {
		return Object.keys(env ?? {}).filter((key) => key.toLowerCase() === LOWER);
	}

	it("unsets an inherited differently-cased key on Windows", () => {
		withInheritedKey("inherited", () => {
			expect(matchingKeys(mergeExecEnv({ [KEY]: undefined }, "win32"))).toEqual([]);
		});
	});

	it("replaces an inherited differently-cased key on Windows", () => {
		withInheritedKey("inherited", () => {
			const merged = mergeExecEnv({ [KEY]: "replacement" }, "win32");
			expect(matchingKeys(merged)).toEqual([KEY]);
			expect(merged?.[KEY]).toBe("replacement");
		});
	});

	it("keeps exact-key semantics on POSIX", () => {
		withInheritedKey("inherited", () => {
			const merged = mergeExecEnv({ [KEY]: undefined }, "linux");
			expect(matchingKeys(merged)).toEqual([LOWER]);
			expect(merged?.[LOWER]).toBe("inherited");
		});
	});

	it("leaves unrelated keys untouched", () => {
		const merged = mergeExecEnv({ [KEY]: "value" }, "linux");
		expect(merged?.[KEY]).toBe("value");
		expect(merged?.PATH ?? "").toBe(process.env.PATH ?? "");
	});
});
