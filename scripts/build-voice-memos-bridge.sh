#!/usr/bin/env bash
# Build only. This does not open the app or grant macOS permissions.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'Usage: bash scripts/build-voice-memos-bridge.sh' >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The Voice Memos access probe requires macOS and Xcode Command Line Tools.' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${repo_root}/native/voice-memos-bridge"
build_root="${repo_root}/build/voice-memos-bridge"
app_path="${build_root}/Mycelia Voice Memos Bridge.app"
if [[ -e "${app_path}" ]]; then
  if pgrep -f "^${app_path}/Contents/MacOS/VoiceMemosBridge" >/dev/null; then
    echo 'Quit Mycelia Voice Memos Bridge before rebuilding it.' >&2
    exit 1
  elif [[ $? -gt 1 ]]; then
    echo 'Cannot check whether the previous build is running; refusing to replace it.' >&2
    exit 1
  fi
fi
mkdir -p "${build_root}/module-cache"
# Build into a fresh directory; retain previous signed builds, never overwrite
# an executable while it might be running or discard an earlier local build.
bundle_build="$(mktemp -d "${build_root}/build.XXXXXX")"
bundle="${bundle_build}/Mycelia Voice Memos Bridge.app"
mkdir -p "${bundle}/Contents/MacOS" "${bundle}/Contents/Resources"
cp "${source_root}/Info.plist" "${bundle}/Contents/Info.plist"
plutil -insert MyceliaRepository -string "${repo_root}" "${bundle}/Contents/Info.plist"
xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O \
  -module-cache-path "${build_root}/module-cache" -framework AppKit \
  "${source_root}/BuildIcon.swift" -o "${bundle_build}/BuildIcon"
"${bundle_build}/BuildIcon" "${repo_root}/backend/public/icon.svg" "${bundle_build}/AppIcon.iconset"
iconutil --convert icns --output "${bundle}/Contents/Resources/AppIcon.icns" "${bundle_build}/AppIcon.iconset"
xcrun swiftc -swift-version 5 -warnings-as-errors -O \
  -module-cache-path "${build_root}/module-cache" \
  -framework AppKit -lsqlite3 \
  "${source_root}/Probe.swift" "${source_root}/DirectImport.swift" "${source_root}/App.swift" \
  -o "${bundle}/Contents/MacOS/VoiceMemosBridge"

# Local ad-hoc signature, not a Developer ID distribution signature. Rebuilding
# can invalidate app-scoped bookmarks; reselect the folder if macOS asks.
codesign --sign - --options runtime \
  --entitlements "${source_root}/Bridge.entitlements" "${bundle}"
codesign --verify --deep --strict --verbose=2 "${bundle}"
plutil -lint "${bundle}/Contents/Info.plist" "${source_root}/Bridge.entitlements"
if [[ -e "${app_path}" || -L "${app_path}" ]]; then
  mv "${app_path}" "${bundle_build}/previous.app"
fi
mv "${bundle}" "${app_path}"
echo "Built sandboxed Voice Memos Bridge: ${app_path}"
echo 'Read-only source; direct import through authenticated 127.0.0.1:8012.'
echo 'No Full Disk Access or permanent staging copies. Automatic import defaults off.'
echo "Open with: open '${app_path}'"
