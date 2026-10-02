#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${repo_root}/native/voice-memos-bridge"
build_root="${repo_root}/build/voice-memos-bridge"
mkdir -p "${build_root}/module-cache"
xcrun swiftc -swift-version 5 -warnings-as-errors \
  -module-cache-path "${build_root}/module-cache" -lsqlite3 \
  "${source_root}/Probe.swift" "${source_root}/DirectImport.swift" \
  "${source_root}/DirectImportTests.swift" "${source_root}/ProbeTests.swift" \
  -o "${build_root}/ProbeTests"
"${build_root}/ProbeTests" "${source_root}/Bridge.entitlements"
