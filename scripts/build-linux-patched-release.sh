#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" ]]; then
	printf 'error: this builder supports Linux hosts only.
' >&2
	exit 1
fi

case "$(uname -m)" in
	x86_64) default_target="linux-x64" ;;
	aarch64|arm64) default_target="linux-arm64" ;;
	*) printf 'error: unsupported Linux architecture: %s
' "$(uname -m)" >&2; exit 1 ;;
esac
target="${PRIME_AGENT_LINUX_TARGET:-$default_target}"
case "$target" in
	linux-x64|linux-x64-baseline|linux-x64-musl|linux-x64-musl-baseline|linux-arm64|linux-arm64-musl) ;;
	*) printf 'error: unsupported Linux target: %s
' "$target" >&2; exit 1 ;;
esac

bun_binary="${BUN_BINARY:-bun}"
if ! command -v "$bun_binary" >/dev/null 2>&1; then
	printf 'error: Bun 1.4.0 is required; set BUN_BINARY to its executable.
' >&2
	exit 1
fi
if [[ "$("$bun_binary" --version)" != "1.4.0" ]]; then
	printf 'error: Bun 1.4.0 is required; found %s.
' "$("$bun_binary" --version)" >&2
	exit 1
fi

cd "$repo_root"
if [[ "${PRIME_AGENT_SKIP_NPM_CI:-0}" != "1" ]]; then
	npm ci --ignore-scripts
fi
BUN_BINARY="$bun_binary" npm --workspace packages/coding-agent run build:binary -- --platform "$target"
printf 'Built Linux release assets: %s
' "$repo_root/packages/coding-agent/binaries/$target"
