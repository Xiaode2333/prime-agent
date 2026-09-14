import { homedir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// Module-load reads (config.ts) must see the real fs; tests override per case.
	mocks.existsSync.mockImplementation(actual.existsSync);
	return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: mocks.spawnSync };
});

import { orderWindowsBashCandidates, resolveKernelBashShell, windowsGitBashCandidates } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	mocks.existsSync.mockClear();
	mocks.spawnSync.mockClear();
});

describe("resolveKernelBashShell on win32", () => {
	it("returns undefined without consulting PATH when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell()).toBeUndefined();
		// The old fallback shelled out to `where bash.exe`; a repo-controlled
		// PATH/where.exe must never pick the kernel shell.
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns the canonical Git Bash install path when present", () => {
		stubWin32();
		const canonical = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelBashShell()).toBe(canonical);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns an explicit shellPath as-is", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell("D:\\tools\\bash.exe")).toBe("D:\\tools\\bash.exe");
		expect(mocks.existsSync).not.toHaveBeenCalled();
	});
});

it("orderWindowsBashCandidates prefers any other bash over WSL's System32 trampoline, keeping it only as a last resort", () => {
	const wsl = "C:\\Windows\\System32\\bash.exe";
	const scoopGitBash = "C:\\Users\\u\\scoop\\shims\\bash.exe";
	expect(orderWindowsBashCandidates([wsl, scoopGitBash], "C:\\Windows")).toEqual([scoopGitBash, wsl]);
	expect(orderWindowsBashCandidates([wsl], "C:\\Windows")).toEqual([wsl]);
	expect(orderWindowsBashCandidates([wsl, scoopGitBash], undefined)).toEqual([wsl, scoopGitBash]);
});

it.each(["C:\\Windows", "C:\\Windows\\", "C:/Windows/", "c:\\WINDOWS\\\\"])(
	"normalizes candidate comparisons under %s without changing paths or stable order",
	(systemRoot) => {
		const wsl = "C:/Windows/System32/bash.exe";
		const neighboringDirectory = "C:\\WindowsExtra\\bash.exe";
		const scoop = "C:\\Users\\u\\scoop\\shims\\bash.exe";
		const winget = "D:/Git/bin/bash.exe";
		expect(orderWindowsBashCandidates([wsl, neighboringDirectory, scoop, winget], systemRoot)).toEqual([
			neighboringDirectory,
			scoop,
			winget,
			wsl,
		]);
		const backslashWsl = wsl.replaceAll("/", "\\");
		expect(orderWindowsBashCandidates([backslashWsl, scoop], systemRoot)).toEqual([scoop, backslashWsl]);
	},
);

describe("windowsGitBashCandidates", () => {
	it("lists Program Files and the per-user install root", () => {
		expect(windowsGitBashCandidates("C:\\Users\\dev", "D:\\Program Files", undefined)).toEqual([
			"D:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
		]);
	});

	it("skips absent Program Files variables but keeps the per-user root", () => {
		expect(windowsGitBashCandidates("C:\\Users\\dev", undefined, undefined)).toEqual([
			"C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
		]);
	});

	it("resolves the per-user Git Bash install", () => {
		stubWin32();
		const perUser = win32.join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe");
		mocks.existsSync.mockImplementation((path: string) => path === perUser);
		try {
			expect(resolveKernelBashShell()).toBe(perUser);
			expect(mocks.spawnSync).not.toHaveBeenCalled();
		} finally {
			mocks.existsSync.mockReturnValue(false);
		}
	});
});
