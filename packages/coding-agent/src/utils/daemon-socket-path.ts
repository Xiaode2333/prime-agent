import { resolve, win32 } from "node:path";

/**
 * Return the lexical socket identity without requiring the socket to exist.
 *
 * Windows identity folds case. It must also collapse the spelling differences POSIX
 * `resolve()` removes, but only for a path spelled like a Windows filesystem path
 * (one containing a backslash): a path spelled with forward slashes is how the
 * shared POSIX-style fixtures, defaults and legacy records are written on every
 * platform, so it keeps the caller's spelling. A relative Windows path is resolved
 * against `baseDir`/cwd exactly like POSIX - leaving it relative let a later cwd
 * change retarget the endpoint. A named pipe (`\\`, `//`) is a device path, not a
 * filesystem path: `win32.resolve` would rewrite it against the current drive.
 */
export function normalizeSocketPath(socketPath: string, baseDir?: string): string {
	if (process.platform === "win32") {
		if (socketPath.startsWith("\\\\") || socketPath.startsWith("//") || !socketPath.includes("\\")) {
			return socketPath.toLowerCase();
		}
		const normalized = win32.normalize(socketPath);
		if (win32.isAbsolute(normalized)) {
			return normalized.toLowerCase();
		}
		return win32.resolve(baseDir ?? process.cwd(), normalized).toLowerCase();
	}
	return baseDir ? resolve(baseDir, socketPath) : resolve(socketPath);
}
