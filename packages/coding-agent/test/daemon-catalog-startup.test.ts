import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
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
});
