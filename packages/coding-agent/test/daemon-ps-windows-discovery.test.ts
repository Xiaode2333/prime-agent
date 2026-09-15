import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyDiscoveredDaemonStatus,
	classifySupervisorOwner,
	type DaemonInfo,
	planReap,
	planShutdownAll,
	scanWindowsSupervisorOwnerDaemons,
} from "../src/cli/daemon-ps.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";
import {
	acquireDaemonSupervisorOwnership,
	type DaemonSupervisorOwnerSnapshot,
	readDaemonSupervisorOwnerSnapshots,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";

const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousRegistryDirEnv = process.env[registryDirEnv];
const cleanupDirs: string[] = [];

afterEach(() => {
	if (previousRegistryDirEnv === undefined) {
		delete process.env[registryDirEnv];
	} else {
		process.env[registryDirEnv] = previousRegistryDirEnv;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function owner(options: Partial<DaemonSupervisorOwnerSnapshot> & { pid: number }): DaemonSupervisorOwnerSnapshot {
	return {
		appVersion: "0.0.0-test",
		descriptorDir: "/tmp/workers",
		generation: `generation-${options.pid}`,
		agentDir: "/tmp/agent",
		phase: "owner",
		socketPath: `\\\\.\\pipe\\\\prime-agent-${options.pid}`,
		...options,
	};
}

describe("classifySupervisorOwner", () => {
	it("verifies a record whose live process still carries the recorded start id", () => {
		expect(
			classifySupervisorOwner(
				{ pid: 42, processStartId: "win:abc" },
				() => true,
				() => "win:abc",
			),
		).toEqual({
			state: "verified",
			pid: 42,
		});
	});

	it("treats a record whose process is gone as stale", () => {
		expect(
			classifySupervisorOwner(
				{ pid: 42, processStartId: "win:abc" },
				() => false,
				() => "win:abc",
			),
		).toEqual({
			state: "stale",
		});
	});

	it("treats a reused pid with a different start id as stale instead of killing it", () => {
		expect(
			classifySupervisorOwner(
				{ pid: 42, processStartId: "win:abc" },
				() => true,
				() => "win:other",
			),
		).toEqual({ state: "stale" });
	});

	it("reports a live process without a recorded start id as unverified", () => {
		const classification = classifySupervisorOwner(
			{ pid: 42 },
			() => true,
			() => "win:abc",
		);
		expect(classification.state).toBe("unverified");
	});

	it("reports a live process whose start id cannot be read as unverified", () => {
		const classification = classifySupervisorOwner(
			{ pid: 42, processStartId: "win:abc" },
			() => true,
			() => undefined,
		);
		expect(classification.state).toBe("unverified");
	});

	it("retries one failed identity read before reporting unverified", () => {
		const observed = [undefined, "win:abc"];
		let calls = 0;
		const classification = classifySupervisorOwner(
			{ pid: 42, processStartId: "win:abc" },
			() => true,
			() => observed[calls++],
		);
		expect(classification).toEqual({ state: "verified", pid: 42 });
		expect(calls).toBe(2);
	});
});

describe("scanWindowsSupervisorOwnerDaemons", () => {
	it("keeps only records whose process identity still matches", () => {
		const scan = scanWindowsSupervisorOwnerDaemons(
			[
				owner({ pid: 1, processStartId: "win:live", socketPath: "/tmp/live.sock" }),
				owner({ pid: 2, processStartId: "win:reused", socketPath: "/tmp/reused.sock" }),
				owner({ pid: 3, processStartId: "win:gone", socketPath: "/tmp/gone.sock" }),
			],
			(pid) => pid !== 3,
			(pid) => (pid === 1 ? "win:live" : "win:other"),
		);
		// Pid 2 is alive but carries another start id, pid 3 is gone: neither is a discovered daemon.
		expect(scan.verified).toEqual([{ pid: 1, socketPath: "/tmp/live.sock" }]);
		expect(scan.unverified).toEqual([]);
	});

	it("separates live processes it could not identify from verified daemons", () => {
		const scan = scanWindowsSupervisorOwnerDaemons(
			[
				owner({ pid: 1, processStartId: "win:live", socketPath: "/tmp/live.sock" }),
				owner({ pid: 2, socketPath: "/tmp/unverified.sock" }),
			],
			() => true,
			(pid) => (pid === 1 ? "win:live" : `win:${pid}`),
		);
		expect(scan.verified).toEqual([{ pid: 1, socketPath: "/tmp/live.sock" }]);
		expect(scan.unverified).toHaveLength(1);
		expect(scan.unverified[0]).toMatchObject({ pid: 2, socketPath: "/tmp/unverified.sock" });
	});

	it("normalizes the recorded socket path", () => {
		const socketPath = "\\\\.\\pipe\\\\prime-agent-daemon";
		const scan = scanWindowsSupervisorOwnerDaemons(
			[owner({ pid: 1, processStartId: "win:a", socketPath })],
			() => true,
			() => "win:a",
		);
		expect(scan.verified[0]?.socketPath).toBe(normalizeSocketPath(socketPath));
	});
});

describe("classifyDiscoveredDaemonStatus", () => {
	it("reports unverified when a live process exists and nothing identifies the endpoint", () => {
		expect(classifyDiscoveredDaemonStatus({ reachable: false, hasUnverifiedProcess: true })).toBe("unverified");
	});

	it("keeps the existing statuses for identified, tracked, and file-only sockets", () => {
		expect(classifyDiscoveredDaemonStatus({ reachable: false, hasIdentifiedProcess: true })).toBe("unreachable");
		expect(classifyDiscoveredDaemonStatus({ reachable: false, hasTrackedWorkers: true })).toBe("unreachable");
		expect(classifyDiscoveredDaemonStatus({ reachable: false })).toBe("orphan-file");
		expect(classifyDiscoveredDaemonStatus({ reachable: true })).toBe("stale");
	});

	it("prefers a reachable daemon over an unverified record on the same socket", () => {
		expect(classifyDiscoveredDaemonStatus({ reachable: true, hasUnverifiedProcess: true })).toBe("stale");
	});
});

describe("shutdown plans for unverified daemons", () => {
	it("never stops or removes an unverified daemon, even with --force", () => {
		const daemon = makeDaemon({
			socketPath: "\\\\.\\pipe\\\\prime-agent-daemon",
			status: "unverified",
			isDefault: true,
			unverifiedReason: "a live process (pid 99) is registered for this daemon but could not be identified",
		});
		const shutdown = planShutdownAll([daemon], true)[0]!;
		expect(shutdown.kind).toBe("skip");
		expect(shutdown.kind === "skip" ? shutdown.reason : "").toContain("not stopping it");
		expect(shutdown.kind === "skip" ? shutdown.reason : "").toContain("pid 99");
		expect(planReap([daemon], true)[0]!.kind).toBe("skip");
	});
});

describe("registry discovery wiring", () => {
	it("reads live owners from the default registry and resolves the current process", async () => {
		const root = mkdtempSync(join(tmpdir(), "daemon-ps-registry-"));
		cleanupDirs.push(root);
		const registryDir = join(root, "supervisor-owners");
		const socketPath = "\\\\.\\pipe\\\\prime-agent-daemon";
		process.env[registryDirEnv] = registryDir;
		mkdirSync(registryDir, { recursive: true });
		const ownership = await acquireDaemonSupervisorOwnership({
			agentDir: join(root, "agent"),
			appVersion: "0.0.0-test",
			descriptorDir: join(root, "workers"),
			generation: "registry-discovery",
			registryDir,
			socketPath,
		});

		const snapshots = readDaemonSupervisorOwnerSnapshots();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ pid: process.pid, socketPath: normalizeSocketPath(socketPath) });

		// The record identifies the test process, so the default registry scan verifies it.
		const scan = scanWindowsSupervisorOwnerDaemons();
		if (getProcessStartId(process.pid)) {
			expect(scan.verified).toEqual([{ pid: process.pid, socketPath: normalizeSocketPath(socketPath) }]);
		} else {
			expect(scan.unverified).toEqual([
				{ pid: process.pid, socketPath: normalizeSocketPath(socketPath), detail: expect.any(String) },
			]);
		}

		await ownership.release();
		expect(readDaemonSupervisorOwnerSnapshots()).toEqual([]);
	});

	it("ignores a registry directory that does not exist", () => {
		const root = mkdtempSync(join(tmpdir(), "daemon-ps-registry-missing-"));
		cleanupDirs.push(root);
		process.env[registryDirEnv] = join(root, "absent");
		expect(readDaemonSupervisorOwnerSnapshots()).toEqual([]);
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
