import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAutonomousRuntimeState, nextAutonomousContinuation } from "../src/core/autonomous.js";
import {
	failingGateCommand,
	gateCommand,
	gateShellKind,
	passingGateCommand,
	quoteGateArgument,
} from "./gate-command.js";

/** A Node install path with a space, exactly like a stock Windows install. */
const WINDOWS_NODE = "C:\\Program Files\\nodejs\\node.exe";

describe("autonomous gate commands", () => {
	it("quotes a Windows executable path with the call operator for PowerShell", () => {
		expect(gateCommand(WINDOWS_NODE, ["-e", "process.exit(0)"], "powershell")).toBe(
			`& 'C:\\Program Files\\nodejs\\node.exe' '-e' 'process.exit(0)'`,
		);
	});

	it("quotes a Windows executable path for cmd.exe without a call operator", () => {
		expect(gateCommand(WINDOWS_NODE, ["-e", "process.exit(0)"], "cmd")).toBe(
			`"C:\\Program Files\\nodejs\\node.exe" "-e" "process.exit(0)"`,
		);
	});

	it("single-quotes POSIX arguments and escapes an embedded quote", () => {
		expect(gateCommand("/usr/bin/node", ["-e", "console.log('gate')"], "posix")).toBe(
			`'/usr/bin/node' '-e' 'console.log('\\''gate'\\'')'`,
		);
	});

	it("doubles an embedded quote inside a PowerShell literal", () => {
		expect(quoteGateArgument("console.log('gate')", "powershell")).toBe("'console.log(''gate'')'");
	});

	it("quotes the executable of the platform gate commands for the resolved shell", () => {
		const kind = gateShellKind();
		expect(passingGateCommand()).toBe(gateCommand(process.execPath, ["-e", "process.exit(0)"], kind));
		expect(passingGateCommand()).toContain(quoteGateArgument(process.execPath, kind));
		expect(failingGateCommand()).toContain(quoteGateArgument(process.execPath, kind));
	});

	it("runs the platform gate commands through the real gate runner", async () => {
		const passing = createAutonomousRuntimeState({
			enabled: true,
			maxContinuations: 1,
			gates: { commands: [passingGateCommand()], maxRetries: 1 },
		});
		expect(
			await nextAutonomousContinuation(passing, fauxAssistantMessage("Done."), { cwd: process.cwd() }),
		).toBeUndefined();
		expect(passing.lastGateFailure).toBeUndefined();

		const failing = createAutonomousRuntimeState({
			enabled: true,
			maxContinuations: 1,
			gates: { commands: [failingGateCommand()], maxRetries: 1 },
		});
		const continuation = await nextAutonomousContinuation(failing, fauxAssistantMessage("Done."), {
			cwd: process.cwd(),
		});
		expect(continuation).toBeDefined();
		// The exit code is the command's own: without wrapCommand, PowerShell
		// reports a failed native command as a successful cmdlet.
		expect(failing.lastGateFailure?.exitText).toBe("exited 1");
	});
});
