import { describe, expect, it } from "vitest";
import { windowsTerminalHint } from "../src/utils/windows-terminal.js";

describe("windowsTerminalHint", () => {
	it("is silent off Windows", () => {
		expect(windowsTerminalHint({ MSYSTEM: "MINGW64" }, "linux")).toBeUndefined();
	});

	it("is silent for a real Windows console", () => {
		expect(windowsTerminalHint({}, "win32")).toBeUndefined();
		expect(windowsTerminalHint({ WT_SESSION: "{guid}" }, "win32")).toBeUndefined();
	});

	it("explains the print-mode fallback for Git Bash and MinTTY", () => {
		const msys = windowsTerminalHint({ MSYSTEM: "MINGW64" }, "win32");
		expect(msys).toContain("MINGW64");
		expect(msys).toContain("print mode");
		expect(msys).toContain("Windows Terminal or PowerShell");

		const cygwin = windowsTerminalHint({ CYGWIN: "nodosfilewarning" }, "win32");
		expect(cygwin).toContain("nodosfilewarning");

		const mintty = windowsTerminalHint({ TERM_PROGRAM: "mintty" }, "win32");
		expect(mintty).toContain("MinTTY");
	});
});
