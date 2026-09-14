#Requires -Version 5.1
<#
.SYNOPSIS
  Prime Agent installer for native Windows.

.DESCRIPTION
  Installs Prime Agent on Windows without WSL. Mirrors the Node route of
  install.sh: resolve the release version, download the verified npm tarball,
  install it globally, make sure the Python kernel prerequisites exist, and
  put the prime-agent command on PATH.

  Run it from PowerShell:
    irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
  or from a checkout:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.PARAMETER Version
  Release version to install, for example 0.9.4 or v0.9.4. Defaults to the
  version published on the selected channel.

.PARAMETER Channel
  Release channel used when -Version is not given: stable (default) or beta.

.PARAMETER BaseUrl
  Release download base URL. Defaults to PRIME_AGENT_DOWNLOAD_BASE_URL or the
  public release bucket.

.PARAMETER NpmPrefix
  npm global prefix used for the install. Defaults to the active npm prefix.

.PARAMETER SkipUv
  Do not install the uv Python package manager. Set this when uv is already
  installed or when the Python kernel is provided through
  PRIME_AGENT_KERNEL_PYTHON.

.PARAMETER SkipKernel
  Skip install-time Python kernel preparation. The kernel is then prepared on
  first run instead.

.PARAMETER SkipPath
  Do not adjust the user PATH.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Channel beta
#>
[CmdletBinding()]
param(
	[string]$Version,
	[ValidateSet("stable", "beta")]
	[string]$Channel = "stable",
	[string]$BaseUrl = $env:PRIME_AGENT_DOWNLOAD_BASE_URL,
	[string]$NpmPrefix,
	[switch]$SkipUv,
	[switch]$SkipKernel,
	[switch]$SkipPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DefaultBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"
$UvInstallCommand = 'irm https://astral.sh/uv/install.ps1 | iex'
$MinNodeVersion = [version]"22.8.0"

function Write-Info {
	param([string]$Message)
	Write-Host "> $Message"
}

function Write-Ok {
	param([string]$Message)
	Write-Host "ok: $Message" -ForegroundColor Green
}

function Write-Warn {
	param([string]$Message)
	Write-Host "warning: $Message" -ForegroundColor Yellow
}

function Fail {
	param([string]$Message)
	Write-Host "error: $Message" -ForegroundColor Red
	exit 1
}

function Enable-Tls12 {
	if ([Net.ServicePointManager]::SecurityProtocol -notmatch "Tls12") {
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	}
}

function Get-ApplicationPath {
	param([string]$Name)
	$command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $command) {
		return $null
	}
	if ($command.Path) {
		return $command.Path
	}
	return $command.Source
}

function Get-RemoteText {
	param([string]$Url)
	Enable-Tls12
	try {
		$response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60
	} catch {
		Fail "could not download $Url. $($_.Exception.Message)"
	}
	return $response.Content.Trim()
}

function Get-RemoteFile {
	param([string]$Url, [string]$Destination)
	Enable-Tls12
	try {
		$client = New-Object Net.WebClient
		$client.DownloadFile($Url, $Destination)
	} catch {
		Fail "could not download $Url. $($_.Exception.Message)"
	}
	if (-not (Test-Path $Destination)) {
		Fail "download reported success but $Destination is missing"
	}
}

function Get-NodeToolchain {
	$nodePath = Get-ApplicationPath "node.exe"
	if (-not $nodePath) {
		$nodePath = Get-ApplicationPath "node"
	}
	if (-not $nodePath) {
		Fail "Node.js was not found. Install Node.js 22.8 or newer, for example: winget install --id OpenJS.NodeJS.LTS -e"
	}

	$rawVersion = (& $nodePath --version) 2>$null
	if (-not $rawVersion) {
		Fail "could not run $nodePath --version"
	}
	$nodeVersion = $rawVersion.Trim().TrimStart("v")
	if ($nodeVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+") {
		Fail "could not parse the Node.js version from '$rawVersion'"
	}
	$parsed = [version]($nodeVersion -replace "-.*$", "")
	if ($parsed -lt $MinNodeVersion) {
		Fail "Node.js $nodeVersion is too old. Prime Agent needs Node.js $MinNodeVersion or newer."
	}

	$npmPath = Get-ApplicationPath "npm.cmd"
	if (-not $npmPath) {
		$npmPath = Get-ApplicationPath "npm"
	}
	if (-not $npmPath) {
		Fail "npm was not found next to Node.js at $nodePath"
	}

	return @{ Node = $nodePath; Npm = $npmPath; NodeVersion = $nodeVersion }
}

function Get-NpmMajor {
	param([string]$Npm)
	$raw = (& $Npm --version) 2>$null
	if (-not $raw) {
		return 0
	}
	$major = $raw.Trim().Split(".")[0]
	$parsed = 0
	if ([int]::TryParse($major, [ref]$parsed)) {
		return $parsed
	}
	return 0
}

function Get-NpmGlobalPrefix {
	param([string]$Npm)
	$prefix = (& $Npm prefix -g) 2>$null
	if (-not $prefix) {
		Fail "could not determine the npm global prefix"
	}
	return $prefix.Trim()
}

function Resolve-ReleaseVersion {
	param([string]$Requested, [string]$Base)
	if ($Requested) {
		$version = $Requested.Trim()
		if (-not $version.StartsWith("v")) {
			$version = "v$version"
		}
		return $version
	}
	$pointer = Get-RemoteText "$Base/$Channel"
	if ($pointer -notmatch "^v?[0-9]+\.[0-9]+\.[0-9]+") {
		Fail "the $Channel channel returned an unexpected version: '$pointer'"
	}
	if (-not $pointer.StartsWith("v")) {
		return "v$pointer"
	}
	return $pointer
}

function Get-NormalizedVersion {
	param([string]$Value)
	if (-not $Value) {
		return ""
	}
	return $Value.Trim().TrimStart("v")
}

function Get-ReleaseManifest {
	param([string]$Base, [string]$Version)
	try {
		$text = Get-RemoteText "$Base/latest.json"
		$manifest = $text | ConvertFrom-Json
	} catch {
		return $null
	}
	if ($null -eq $manifest) {
		return $null
	}
	if ((Get-NormalizedVersion $manifest.version) -eq (Get-NormalizedVersion $Version)) {
		return $manifest
	}
	return $null
}

function Get-ManifestTarballUrl {
	param([string]$Base, $Manifest, [string]$Version)
	if ($Manifest.tarball) {
		return "$Base/$($Manifest.tarball.TrimStart("/"))"
	}
	return "$Base/releases/$Version/prime-agent-" + (Get-NormalizedVersion $Version) + ".tgz"
}

function Find-TarballEntry {
	param($Manifest, [string]$PackageName)
	foreach ($entry in $Manifest.tarballs) {
		if ($entry.package -eq $PackageName) {
			return $entry
		}
	}
	return $null
}

function Remove-StaleNpmStagingDirectories {
	param([string]$Prefix, [string]$PackageName)
	$globalModules = Join-Path $Prefix "node_modules"
	if (-not (Test-Path $globalModules)) {
		return
	}
	Get-ChildItem -Path $globalModules -Directory -Filter ".$PackageName-*" -ErrorAction SilentlyContinue | ForEach-Object {
		Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
	}
}

function Test-NpmLockError {
	param([string]$Output)
	return $Output -match "(?i)EBUSY|EPERM|ELOCKED|resource busy or locked|cannot access the file"
}

function Invoke-NpmInstall {
	param([string]$Prefix, [string]$PackageName, [string]$Npm, [string[]]$Arguments, [int]$MaxAttempts = 3)
	$attempt = 0
	while ($true) {
		$attempt += 1
		$output = & $Npm @Arguments 2>&1
		$code = $LASTEXITCODE
		foreach ($line in $output) {
			Write-Host $line
		}
		if ($code -eq 0) {
			return
		}
		$text = ($output | Out-String)
		if ($attempt -ge $MaxAttempts -or -not (Test-NpmLockError $text)) {
			Fail "npm install failed with exit code $code"
		}
		# Windows holds transient locks on freshly written native modules and
		# antivirus can extend them; npm leaves a staging directory behind.
		Write-Warn "npm install hit a Windows file lock (attempt $attempt of $MaxAttempts); cleaning up and retrying"
		Start-Sleep -Seconds (2 * $attempt)
		Remove-StaleNpmStagingDirectories -Prefix $Prefix -PackageName $PackageName
		if ($attempt -ge 2) {
			$installedPackage = Join-Path $Prefix "node_modules\$PackageName"
			if (Test-Path $installedPackage) {
				Remove-Item -Recurse -Force $installedPackage -ErrorAction SilentlyContinue
			}
		}
	}
}

function Install-Release {
	param([string]$Base, [string]$Version, [string]$Npm, [string]$TarballPath, [string]$Sha256, [string]$Prefix)
	$mode = if ([string]::IsNullOrEmpty($Sha256)) { "unverified" } else { "verified" }
	Write-Info "installing prime-agent $Version ($mode tarball) with npm"

	$env:PRIME_AGENT_INSTALL_UV = "1"
	$arguments = @("install", "-g", "--no-fund", "--no-audit", "--loglevel=error")
	if (-not [string]::IsNullOrEmpty($NpmPrefix)) {
		$arguments += @("--prefix", $NpmPrefix)
	}
	if ((Get-NpmMajor $Npm) -ge 12) {
		# npm 12 requires explicit policy flags for remote tarballs.
		$arguments += @("--allow-remote=all", "--allow-scripts=$TarballPath")
	}
	if (-not $SkipKernel) {
		$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "1"
		$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
	}
	$arguments += $TarballPath

	Invoke-NpmInstall -Prefix $Prefix -PackageName "prime-agent" -Npm $Npm -Arguments $arguments
}

function Ensure-Uv {
	if ($SkipUv) {
		Write-Info "skipping uv setup (-SkipUv)"
		return $null
	}
	$onPath = Get-ApplicationPath "uv.exe"
	if ($onPath) {
		Write-Ok "uv already available at $onPath"
		return $onPath
	}
	$localUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
	if (Test-Path $localUv) {
		Write-Ok "uv already available at $localUv"
		return $localUv
	}

	Write-Info "installing uv (needed once to set up the Python kernel)"
	$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
	if (-not (Test-Path $powershellPath)) {
		$powershellPath = "powershell.exe"
	}
	& $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $UvInstallCommand
	if (Test-Path $localUv) {
		Write-Ok "uv installed at $localUv"
		return $localUv
	}
	$afterInstall = Get-ApplicationPath "uv.exe"
	if ($afterInstall) {
		Write-Ok "uv installed at $afterInstall"
		return $afterInstall
	}
	Write-Warn "uv was not installed automatically. Set the kernel interpreter instead with: `$env:PRIME_AGENT_KERNEL_PYTHON='<python.exe>', or run: $UvInstallCommand"
	return $null
}

function Add-ToUserPath {
	param([string]$Directory)
	if (-not (Test-Path $Directory)) {
		return $false
	}
	$current = [Environment]::GetEnvironmentVariable("Path", "User")
	if (-not $current) {
		$current = ""
	}
	$entries = $current.Split(";") | Where-Object { $_ }
	foreach ($entry in $entries) {
		if ($entry.TrimEnd("\") -ieq $Directory.TrimEnd("\")) {
			return $false
		}
	}
	$updated = (@($entries) + @($Directory)) -join ";"
	[Environment]::SetEnvironmentVariable("Path", $updated, "User")
	$env:Path = "$env:Path;$Directory"
	return $true
}

function Confirm-FileHash {
	param([string]$Path, [string]$Expected)
	$actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash
	if ($actual -ine $Expected) {
		Fail "sha256 mismatch for $Path`n  expected $Expected`n  actual   $actual"
	}
	return $actual
}

function Test-InstalledCommand {
	param([string]$Prefix)
	$candidates = @(
		(Join-Path $Prefix "prime-agent.cmd"),
		(Join-Path $Prefix "prime-agent.exe"),
		(Join-Path $Prefix "node_modules\prime-agent\dist\bundle\cli.js")
	)
	foreach ($candidate in $candidates) {
		if (Test-Path $candidate) {
			return $candidate
		}
	}
	return $null
}

function Invoke-Main {
	if ($env:OS -ne "Windows_NT") {
		Fail "this installer is for Windows. Use install.sh on macOS or Linux."
	}

	Write-Info "Prime Agent installer (Windows)"

	$toolchain = Get-NodeToolchain
	Write-Ok "node $($toolchain.NodeVersion) at $($toolchain.Node)"

	$prefix = $NpmPrefix
	if ([string]::IsNullOrEmpty($prefix)) {
		$prefix = Get-NpmGlobalPrefix $toolchain.Npm
	}
	Write-Ok "npm global prefix: $prefix"

	if (-not $BaseUrl) {
		$BaseUrl = $DefaultBaseUrl
	}
	$base = $BaseUrl.TrimEnd("/")

	Ensure-Uv | Out-Null

	$releaseVersion = Resolve-ReleaseVersion -Requested $Version -Base $base
	Write-Ok "release version: $releaseVersion"

	$manifest = Get-ReleaseManifest -Base $base -Version $releaseVersion
	$tarballName = "prime-agent-" + $releaseVersion.TrimStart("v") + ".tgz"
	$sha256 = $null
	if ($manifest) {
		$entry = Find-TarballEntry -Manifest $manifest -PackageName "prime-agent"
		if ($entry) {
			$tarballName = $entry.file
			$sha256 = $entry.sha256
		}
	} else {
		Write-Warn "no release manifest found for $releaseVersion; the download cannot be checksum-verified"
	}

	$tarballUrl = Get-ManifestTarballUrl -Base $base -Manifest $manifest -Version $releaseVersion
	if (-not $tarballName) {
		$tarballName = "prime-agent-" + (Get-NormalizedVersion $releaseVersion) + ".tgz"
	}
	$downloadPath = Join-Path $env:TEMP $tarballName
	Write-Info "downloading $tarballUrl"
	Get-RemoteFile -Url $tarballUrl -Destination $downloadPath
	if ($sha256) {
		Confirm-FileHash -Path $downloadPath -Expected $sha256 | Out-Null
		Write-Ok "sha256 verified"
	}

	Install-Release -Base $base -Version $releaseVersion -Npm $toolchain.Npm -TarballPath $downloadPath -Sha256 $sha256 -Prefix $prefix

	$command = Test-InstalledCommand -Prefix $prefix
	if (-not $command) {
		Write-Warn "the install finished but no prime-agent command was found under $prefix"
	} else {
		Write-Ok "prime-agent installed at $command"
	}

	if (-not $SkipPath) {
		if (Add-ToUserPath -Directory $prefix) {
			Write-Ok "added $prefix to the user PATH (open a new terminal to use it)"
		}
	}

	Remove-Item -Force $downloadPath -ErrorAction SilentlyContinue

	Write-Host ""
	Write-Host "Prime Agent $releaseVersion is installed."
	Write-Host "Start it with:"
	Write-Host "  prime-agent"
	Write-Host ""
	Write-Host "If the command is not found yet, open a new terminal or run:"
	Write-Host "  `$env:Path = `"$prefix;`$env:Path`""
	Write-Host ""
	Write-Host "To see background service status later: prime-agent doctor"
}

Invoke-Main
