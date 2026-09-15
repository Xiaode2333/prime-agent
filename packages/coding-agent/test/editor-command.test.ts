import { describe, expect, it } from "vitest";
import { launchEditor, parseEditorCommand } from "../src/utils/editor-command.js";

describe("parseEditorCommand", () => {
	it("reads a bare command", () => {
		expect(parseEditorCommand("vim", "linux")).toEqual({ file: "vim", args: [] });
	});

	it("keeps arguments", () => {
		expect(parseEditorCommand("code --wait", "linux")).toEqual({ file: "code", args: ["--wait"] });
	});

	it("keeps a quoted path with spaces intact", () => {
		const command = String.raw`"C:\Program Files\Microsoft VS Code\Code.exe" --wait --new-window`;
		expect(parseEditorCommand(command, "win32")).toEqual({
			file: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
			args: ["--wait", "--new-window"],
		});
	});

	it("accepts single quotes on POSIX", () => {
		expect(parseEditorCommand("'/opt/my editor/edit' -f", "linux")).toEqual({
			file: "/opt/my editor/edit",
			args: ["-f"],
		});
	});

	it("honours backslash escapes inside double quotes on POSIX only", () => {
		expect(parseEditorCommand('"a\\"b" c', "linux")).toEqual({ file: 'a"b', args: ["c"] });
		expect(parseEditorCommand(String.raw`"C:\tools\ed.exe" x`, "win32")).toEqual({
			file: String.raw`C:\tools\ed.exe`,
			args: ["x"],
		});
	});

	it("collapses surrounding whitespace and reports nothing for empty input", () => {
		expect(parseEditorCommand("  nano  ", "linux")).toEqual({ file: "nano", args: [] });
		expect(parseEditorCommand("   ", "linux")).toBeUndefined();
		expect(parseEditorCommand("", "linux")).toBeUndefined();
	});

	it("treats an unterminated quote as extending to the end", () => {
		expect(parseEditorCommand('"C:\\Program Files\\Ed', "win32")).toEqual({
			file: String.raw`C:\Program Files\Ed`,
			args: [],
		});
	});
});

describe("launchEditor", () => {
	it("reports an empty command instead of spawning anything", () => {
		const result = launchEditor("   ", "/tmp/ignored.md", "linux");
		expect(result.status).toBeNull();
		expect(result.error?.message).toContain("empty");
	});

	it("surfaces a missing executable instead of pretending the edit succeeded", () => {
		const result = launchEditor("prime-agent-no-such-editor-12345", "/tmp/ignored.md");
		// POSIX reports a spawn error; the Windows shim fallback reports the shell's
		// non-zero status. Either way the caller must be able to tell the user.
		expect(result.error !== undefined || result.status !== 0).toBe(true);
	});

	it.skipIf(process.platform === "win32")("runs a real command and returns its status", () => {
		const result = launchEditor("true", "/tmp/ignored.md", "linux");
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
	});
});
