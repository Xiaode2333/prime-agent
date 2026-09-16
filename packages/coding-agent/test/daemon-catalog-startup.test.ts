import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
	args: [] as string[],
	child: undefined as (EventEmitter & { connected: boolean }) | undefined,
}));

vi.mock("node:child_process", () => ({
	spawn(_command: string, args: string[], _options: SpawnOptions): ChildProcess {
		spawnState.args = args;
		const child = Object.assign(new EventEmitter(), {
			connected: true,
			disconnect: vi.fn(),
			kill: vi.fn(),
			send: vi.fn(),
		});
		spawnState.child = child;
		return child as unknown as ChildProcess;
	},
}));

import { DaemonCatalogClient, isDaemonCatalogSourcePath } from "../src/modes/daemon/daemon-catalog-process.js";

// The compiled module is the shape an install has; the source module always selects the
// source entrypoint, so only this import reaches the compiled branch.
const compiledCatalogModule = fileURLToPath(new URL("../dist/modes/daemon/daemon-catalog-process.js", import.meta.url));

afterEach(() => {
	vi.useRealTimers();
	spawnState.args = [];
	spawnState.child = undefined;
});

describe("daemon catalog startup", () => {
	it("does not mistake an ancestor src directory for the package source tree", () => {
		// The product compares paths spelled the way its own platform spells them
		// (`join(packageDir, "src")` + `sep`), so the fixture must too: a literal
		// POSIX spelling is not a module path on win32.
		const packageDir = join("/usr/src/app/packages/coding-agent");

		expect(
			isDaemonCatalogSourcePath(join(packageDir, "dist/modes/daemon/daemon-catalog-process.js"), packageDir),
		).toBe(false);
		expect(
			isDaemonCatalogSourcePath(join(packageDir, "src/modes/daemon/daemon-catalog-process.ts"), packageDir),
		).toBe(true);
	});

	it("uses the dedicated entrypoint and allows a cold start past five seconds", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		expect(spawnState.args.some((arg) => /daemon-catalog-entry\.(?:js|ts)$/.test(arg))).toBe(true);
		await vi.advanceTimersByTimeAsync(6000);
		spawnState.child?.emit("message", { type: "ready" });
		await expect(starting).resolves.toBeUndefined();
	});

	it("rejects immediately when the catalog exits during startup", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		spawnState.child?.emit("exit", 1, null);
		await expect(starting).rejects.toThrow(/exited during startup/);
	});

	it.skipIf(!existsSync(compiledCatalogModule))(
		"starts the compiled catalog on an install that does not ship tsx",
		async () => {
			// A dist-only install has no tsx dev tool. Resolving it eagerly threw
			// MODULE_NOT_FOUND before the entrypoint check, so the catalog child never
			// started and every saved-session list came back empty. The compiled module is
			// imported here because only a compiled entrypoint selects that branch.
			vi.resetModules();
			vi.doMock("node:module", async (importOriginal) => {
				const actual = await importOriginal<typeof import("node:module")>();
				return {
					...actual,
					createRequire: (...args: Parameters<typeof actual.createRequire>) => {
						const requireFrom = actual.createRequire(...args);
						const resolve = requireFrom.resolve.bind(requireFrom);
						requireFrom.resolve = ((id: string) => {
							if (id === "tsx") {
								throw Object.assign(new Error("Cannot find module 'tsx'"), { code: "MODULE_NOT_FOUND" });
							}
							return resolve(id);
						}) as typeof requireFrom.resolve;
						return requireFrom;
					},
				};
			});
			try {
				const { DaemonCatalogClient: CompiledClient } = await import(pathToFileURL(compiledCatalogModule).href);
				vi.useFakeTimers();
				const client = new CompiledClient(() => {});
				const starting = client.start();

				// The compiled entrypoint is spawned without --import, so a missing tsx is not fatal.
				expect(spawnState.args.some((arg) => /daemon-catalog-entry\.js$/.test(arg))).toBe(true);
				expect(spawnState.args).not.toContain("--import");
				spawnState.child?.emit("message", { type: "ready" });
				await expect(starting).resolves.toBeUndefined();
			} finally {
				vi.doUnmock("node:module");
				vi.resetModules();
			}
		},
	);
});
