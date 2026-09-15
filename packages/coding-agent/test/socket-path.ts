/**
 * Cross-platform listen endpoints for test fixtures.
 *
 * Windows accepts only a named pipe under `\\.\pipe\`. `server.listen()` on a
 * POSIX-style path such as `join(tmpdir(), "d.sock")` fails with EACCES, and a
 * bare name fails too, so a fixture that listens on one never calls its listen
 * callback and the test hangs until its timeout instead of failing. Pipe names
 * are machine-global, so include the pid and a counter to keep parallel tests
 * apart.
 *
 * This module imports nothing but `node:path`: pulling the shared test utilities
 * in here drags the whole product module graph into daemon tests, which stalls
 * collection on Windows.
 */

import { join } from "node:path";

let counter = 0;

export function testSocketPath(directory: string, name = "daemon.sock"): string {
	if (process.platform === "win32") {
		const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "-");
		return `\\\\.\\pipe\\prime-agent-test-${process.pid}-${++counter}-${safeName}`;
	}
	return join(directory, name);
}
