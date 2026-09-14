/**
 * Owner-only protection for directories and files.
 *
 * POSIX enforces this with mode bits, so `mkdir(..., 0o700)` and
 * `chmod(0o600)` are real access control. Windows has no equivalent: the mode
 * argument only toggles the read-only attribute, so an inherited ACL leaves
 * `~/.prime` (auth tokens, session transcripts, leases, journals) readable by
 * every local account that inherits it. On win32 this module removes inherited
 * ACEs with icacls and grants only the current account, which is the Windows
 * equivalent of `0o700`.
 */

import { existsSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { spawnSyncHidden } from "./child-process.js";

const log = getLogger("coding-agent.secure-dir");

const ICACLS_TIMEOUT_MS = 60_000;
const HARDENING_MARKER = ".acl-hardened";

const hardenedPaths = new Set<string>();
const loggedFailures = new Set<string>();

/** Absolute System32 icacls: a bare name could resolve a planted CWD icacls.exe. */
function icaclsPath(): string {
	return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
}

function currentAccountName(): string | undefined {
	const user = process.env.USERNAME?.trim();
	if (!user) {
		return undefined;
	}
	const domain = process.env.USERDOMAIN?.trim();
	return domain ? `${domain}\\${user}` : user;
}

export function aclHardeningDisabled(): boolean {
	const value = process.env.PRIME_AGENT_SKIP_ACL_HARDENING;
	return value === "1" || value?.toLowerCase() === "true";
}

function runIcacls(args: readonly string[]): boolean {
	try {
		const result = spawnSyncHidden(icaclsPath(), args, {
			stdio: "pipe",
			timeout: ICACLS_TIMEOUT_MS,
			env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
		});
		if (result.status === 0) {
			return true;
		}
		logFailure(args[0] ?? "icacls", result.stderr?.toString().trim() || `exit code ${result.status}`);
		return false;
	} catch (error) {
		logFailure(args[0] ?? "icacls", error instanceof Error ? error.message : String(error));
		return false;
	}
}

function logFailure(target: string, detail: string): void {
	if (loggedFailures.has(target)) {
		return;
	}
	loggedFailures.add(target);
	log.warn(`could not restrict the Windows ACL for ${target}: ${detail}`);
}

/**
 * Drop inherited ACEs and grant the account explicit access to a path and, when
 * recursive, to everything inside it. The (OI)(CI) inheritance flags are invalid
 * on files, so they belong to the directory pass only: applying them to a file
 * through /T leaves the file with no ACE at all.
 */
function applyRestrictedAcl(path: string, recursive: boolean): boolean {
	const account = currentAccountName();
	if (!account) {
		logFailure(path, "USERNAME is not set");
		return false;
	}
	const args = [path, "/inheritance:r", "/grant:r", `${account}:F`];
	if (recursive) {
		// /T applies the same ACL to existing children, /C keeps going past locked
		// files, /Q suppresses per-file success output.
		args.push("/T", "/C", "/Q");
	}
	return runIcacls(args);
}

/**
 * Restrict a directory to the current account, and let it pass the restriction on
 * to children created later. No-op off win32.
 */
export function hardenDirectoryAcl(directory: string, options: { recursive?: boolean } = {}): boolean {
	if (process.platform !== "win32" || aclHardeningDisabled()) {
		return false;
	}
	if (hardenedPaths.has(directory)) {
		return true;
	}
	const account = currentAccountName();
	if (!account || !applyRestrictedAcl(directory, options.recursive === true)) {
		return false;
	}
	if (!runIcacls([directory, "/grant:r", `${account}:(OI)(CI)F`, "/Q"])) {
		return false;
	}
	hardenedPaths.add(directory);
	return true;
}

/** Restrict a single file to the current account. No-op off win32. */
export function hardenFileAcl(filePath: string): boolean {
	if (process.platform !== "win32" || aclHardeningDisabled()) {
		return false;
	}
	if (hardenedPaths.has(filePath)) {
		return true;
	}
	if (!applyRestrictedAcl(filePath, false)) {
		return false;
	}
	hardenedPaths.add(filePath);
	return true;
}

/**
 * Harden a directory tree once and leave a marker so later runs skip the walk.
 * Best effort: a failure is logged and the caller continues, because an
 * unhardened config directory must not stop the agent from starting.
 */
export function ensureDirectoryHardened(directory: string): void {
	if (process.platform !== "win32" || aclHardeningDisabled()) {
		return;
	}
	const marker = win32.join(directory, HARDENING_MARKER);
	if (existsSync(marker)) {
		hardenedPaths.add(directory);
		return;
	}
	if (!hardenDirectoryAcl(directory, { recursive: true })) {
		return;
	}
	try {
		writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
		hardenFileAcl(marker);
	} catch {
		// The marker is an optimization; the ACL itself already applied.
	}
}

/** Test seam: forget the per-process hardening cache. */
export function resetAclHardeningCache(): void {
	hardenedPaths.clear();
}
