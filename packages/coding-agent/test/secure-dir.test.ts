import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	aclHardeningDisabled,
	ensureDirectoryHardened,
	hardenDirectoryAcl,
	hardenFileAcl,
	resetAclHardeningCache,
} from "../src/utils/secure-dir.js";

const isWindows = process.platform === "win32";
let created: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-acl-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	resetAclHardeningCache();
	for (const dir of created) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
	created = [];
});

function icaclsPrincipals(path: string): string[] {
	const result = spawnSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [path], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const principals: string[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("Successfully processed") || line.includes("processed file:")) {
			continue;
		}
		let tokens = line.split(/\s+/);
		// A leading drive-qualified path is the object under inspection, not an ACE.
		if (tokens[0] && /^[A-Za-z]:\\/.test(tokens[0])) {
			tokens = tokens.slice(1);
		}
		for (const token of tokens) {
			const principal = /^(.*?):\(/.exec(token)?.[1];
			if (principal) {
				principals.push(principal);
			}
		}
	}
	return principals;
}

function expectedAccount(): string {
	const user = process.env.USERNAME ?? "";
	const domain = process.env.USERDOMAIN;
	return (domain ? `${domain}\\${user}` : user).toLowerCase();
}

describe("secure-dir", () => {
	it("is a no-op off Windows", () => {
		if (isWindows) return;
		expect(aclHardeningDisabled()).toBe(false);
		expect(hardenDirectoryAcl(tmpdir())).toBe(false);
		expect(hardenFileAcl(join(tmpdir(), "prime-acl-missing.json"))).toBe(false);
	});

	it.skipIf(!isWindows)("leaves only the current account on a hardened directory tree", () => {
		const dir = makeTempDir();
		const nested = join(dir, "sessions");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "session.jsonl"), "{}\n", "utf8");
		writeFileSync(join(dir, "auth.json"), "{}\n", "utf8");

		expect(hardenDirectoryAcl(dir, { recursive: true })).toBe(true);

		const account = expectedAccount();
		for (const target of [dir, nested, join(nested, "session.jsonl"), join(dir, "auth.json")]) {
			const principals = icaclsPrincipals(target);
			expect(principals.length, `no principals reported for ${target}`).toBeGreaterThan(0);
			for (const principal of principals) {
				expect(principal.toLowerCase(), `${target} still exposes ${principal}`).toBe(account);
			}
		}
	});

	it.skipIf(!isWindows)("makes later files inherit the restricted ACL", () => {
		const dir = makeTempDir();
		expect(hardenDirectoryAcl(dir)).toBe(true);

		const later = join(dir, "later.json");
		writeFileSync(later, "{}\n", "utf8");

		const principals = icaclsPrincipals(later).map((principal) => principal.toLowerCase());
		expect(principals).toEqual([expectedAccount()]);
	});

	it.skipIf(!isWindows)("hardens once per process and leaves a marker", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "auth.json"), "{}\n", "utf8");

		ensureDirectoryHardened(dir);

		expect(existsSync(join(dir, ".acl-hardened"))).toBe(true);
		expect(icaclsPrincipals(join(dir, "auth.json")).map((p) => p.toLowerCase())).toEqual([expectedAccount()]);
	});

	it.skipIf(!isWindows)("restricts a single file", () => {
		const dir = makeTempDir();
		const file = join(dir, "auth.json");
		writeFileSync(file, "{}\n", "utf8");

		expect(hardenFileAcl(file)).toBe(true);

		expect(icaclsPrincipals(file).map((p) => p.toLowerCase())).toEqual([expectedAccount()]);
	});
});
