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

import {
	getShellConfig,
	orderWindowsBashCandidates,
	resolveKernelBashShell,
	wrapPowerShellCommand,
} from "../src/utils/shell.js";

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

	it("returns Windows PowerShell, not Git Bash, when both are installed", () => {
		stubWin32();
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		mocks.existsSync.mockImplementation((path: string) => path === gitBash || path === powershell);

		expect(resolveKernelBashShell()).toBe(powershell);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("honours an explicit Git Bash shellPath", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(true);

		expect(resolveKernelBashShell("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(
			"C:\\Program Files\\Git\\bin\\bash.exe",
		);
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

describe("getShellConfig on win32", () => {
	const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

	function withComSpec<T>(value: string, run: () => T): T {
		const previous = process.env.ComSpec;
		process.env.ComSpec = value;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env.ComSpec;
			else process.env.ComSpec = previous;
		}
	}

	it("uses Windows PowerShell without any POSIX shell installed", () => {
		stubWin32();
		mocks.existsSync.mockImplementation((path: string) => path === powershell);

		withComSpec("C:\\Windows\\System32\\cmd.exe", () => {
			const config = getShellConfig();
			expect(config.shell).toBe(powershell);
			expect(config.kind).toBe("powershell");
			expect(config.args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
			expect(config.wrapCommand).toBeDefined();
			expect(mocks.spawnSync).not.toHaveBeenCalled();
		});
	});

	it("falls back to cmd.exe when Windows PowerShell is unavailable", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		withComSpec("C:\\Windows\\System32\\cmd.exe", () => {
			const config = getShellConfig();
			expect(config.shell).toBe("C:\\Windows\\System32\\cmd.exe");
			expect(config.kind).toBe("cmd");
			expect(config.args).toEqual(["/d", "/s", "/c"]);
			expect(config.wrapCommand).toBeUndefined();
		});
	});

	it("classifies an explicit shellPath instead of assuming POSIX", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(true);

		const config = getShellConfig("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
		expect(config.kind).toBe("powershell");
		expect(config.args).toContain("-Command");
	});
});

describe("wrapPowerShellCommand", () => {
	it("maps the command outcome onto the process exit code", () => {
		const wrapped = wrapPowerShellCommand("Get-ChildItem");
		expect(wrapped.startsWith("Get-ChildItem\n")).toBe(true);
		expect(wrapped).toContain("$LASTEXITCODE");
		expect(wrapped).toContain("exit");
	});
});
