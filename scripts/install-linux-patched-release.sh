#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" ]]; then
	printf 'error: this installer supports Linux hosts only.
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
source_dir="${1:-$repo_root/packages/coding-agent/binaries/$target}"
if [[ ! -x "$source_dir/prime-agent" ]]; then
	printf 'error: expected a built executable at %s/prime-agent. Run scripts/build-linux-patched-release.sh first.
' "$source_dir" >&2
	exit 1
fi

install_root="${PRIME_AGENT_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/prime-agent}"
version="$(node -e 'console.log(require(process.argv[1]).version)' "$repo_root/packages/coding-agent/package.json")"
digest="$(sha256sum "$source_dir/prime-agent" | awk '{print $1}')"
release_name="${version}-${target}-local-${digest:0:12}"
release_dir="$install_root/releases/$release_name"
staging_dir="$install_root/releases/.${release_name}.staging.$$"
bin_dir="$install_root/bin"

mkdir -p "$install_root/releases" "$bin_dir"
if [[ ! -d "$release_dir" ]]; then
	trap 'rm -rf -- "$staging_dir"' EXIT
	mkdir "$staging_dir"
	cp -a "$source_dir/." "$staging_dir/"
	printf '%s
' "$digest" > "$staging_dir/.archive-sha256"
	printf 'local source: %s
' "$repo_root" > "$staging_dir/.install-source"
	"$staging_dir/prime-agent" --version >/dev/null
	"$staging_dir/prime-agent" --help >/dev/null
	mv "$staging_dir" "$release_dir"
	trap - EXIT
fi

current_link="$bin_dir/prime-agent"
previous_target=""
if [[ -L "$current_link" ]]; then
	previous_target="$(readlink "$current_link")"
fi
new_link="$bin_dir/.prime-agent.new.$$"
ln -s "../releases/$release_name/prime-agent" "$new_link"
mv -Tf "$new_link" "$current_link"
if [[ -n "$previous_target" ]]; then
	previous_link="$bin_dir/.previous.new.$$"
	ln -s "$previous_target" "$previous_link"
	mv -Tf "$previous_link" "$bin_dir/previous"
fi
printf 'Activated Linux patched release: %s
' "$release_dir"
printf 'Restart Prime Agent to load it: prime-agent shutdown
'
