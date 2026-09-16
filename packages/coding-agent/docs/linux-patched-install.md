# Linux patched-release installation

The Linux compaction-overflow safety patch is maintained separately from the
`windows-native-support` branch. Use the `linux-compaction-overflow-safety`
branch on a Linux host.

```bash
git clone --branch linux-compaction-overflow-safety git@github.com:Xiaode2333/prime-agent.git
cd prime-agent
BUN_BINARY=/path/to/bun-1.4.0 scripts/build-linux-patched-release.sh
scripts/install-linux-patched-release.sh
prime-agent shutdown
```

The builder defaults to `linux-x64` on x86_64 and `linux-arm64` on ARM64. Set
`PRIME_AGENT_LINUX_TARGET` to an explicit supported Linux target when a musl or
baseline binary is required. The installer stages and smoke-tests a new release
before atomically changing `~/.local/share/prime-agent/bin/prime-agent`; it
preserves the previous target as `bin/previous`.

Do not run either script on Windows. The Windows changes remain on the separate
`windows-native-support` branch.
