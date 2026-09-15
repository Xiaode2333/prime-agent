import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Structural and syntax check for install.ps1.
 *
 * separate from check-installer.mjs because that one drives install.sh through a
 * POSIX `sh` harness, which does not exist on Windows. This script runs on every
 * platform, so the Windows installer is gated in the Linux check job and in the
 * release pipeline (which runs `npm run check` before publishing).
 *
 * The release workflow renders install-beta.ps1 by replacing one exact string, so
 * a rename here would only surface at publish time; assert the contract instead.
 */
const failures = [];

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

const installer = readFileSync("install.ps1", "utf-8");

check(installer.startsWith("#Requires -Version 5.1"), "install.ps1 must declare the 5.1 baseline");
check(
	installer.includes('[string]$Channel = "stable"'),
	'install.ps1 must keep the exact `[string]$Channel = "stable"` default that the beta render replaces',
);
check(
	installer.match(/\[string\]\$Channel = "stable"/g)?.length === 1,
	'install.ps1 must contain exactly one `[string]$Channel = "stable"` default',
);
for (const parameter of ["$Version", "$Channel", "$BaseUrl", "$NpmPrefix", "$SkipUv", "$SkipKernel", "$SkipPath"]) {
	check(installer.includes(parameter), `install.ps1 must expose ${parameter}`);
}
check(installer.includes("/latest.json"), "install.ps1 must read the release manifest for checksums");
check(installer.includes("Get-FileHash"), "install.ps1 must verify the downloaded tarball");
check(installer.includes("releases/"), "install.ps1 must download the versioned release tarball");
check(
	/https:\/\/pub-[a-z0-9]+\.r2\.dev/.test(installer),
	"install.ps1 must default to the HTTPS release origin",
);
// Windows PowerShell 5.1 has no `&&` chaining operator; the installer must use `;`.
check(!/\s&&\s/.test(installer), "install.ps1 must not use the PowerShell 7-only `&&` operator");

/**
 * A PowerShell that can parse the file: Windows PowerShell 5.1 by absolute path on
 * win32 (the floor the installer targets), else pwsh (PowerShell 7, which ships on
 * GitHub's runners). Skipping is deliberate: the check must not fail on a host
 * with neither.
 */
function powershellCandidates() {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		return [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "pwsh"];
	}
	return ["pwsh"];
}

const parseDirectory = mkdtempSync(join(tmpdir(), "prime-agent-ps1-check-"));
try {
	const parseScript = join(parseDirectory, "parse-installer.ps1");
	writeFileSync(
		parseScript,
		[
			"param([string]$Path)",
			"$errors = $null",
			"[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path).Path, [ref]$null, [ref]$errors) | Out-Null",
			"if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
		].join("\n"),
		"utf-8",
	);
	let parsed;
	for (const candidate of powershellCandidates()) {
		parsed = spawnSync(
			candidate,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parseScript, "install.ps1"],
			{ encoding: "utf-8" },
		);
		if (!parsed.error && parsed.status !== null) {
			check(parsed.status === 0, `install.ps1 has PowerShell parse errors: ${(parsed.stderr ?? "").trim()}`);
			break;
		}
	}
	if (!parsed || parsed.error || parsed.status === null) {
		console.log("Windows installer check: no PowerShell available, skipping the syntax parse.");
	}
} finally {
	rmSync(parseDirectory, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Windows installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Windows installer check passed.");
