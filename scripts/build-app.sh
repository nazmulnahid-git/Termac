#!/usr/bin/env bash
# Builds the native app and wraps it in Termorc.app.
#   scripts/build-app.sh            debug build  → .build/Termorc.app
#   scripts/build-app.sh release    release build → .build/release-app/Termorc.app
#   scripts/build-app.sh debug run  build, then open it (TERMORC_DATA_DIR is passed through)
set -euo pipefail
cd "$(dirname "$0")/.."

config="${1:-debug}"

swift build -c "$config" --product Termorc
bin="$(swift build -c "$config" --show-bin-path)/Termorc"

out=".build/Termorc.app"
[[ "$config" == release ]] && out=".build/release-app/Termorc.app"
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin" "$out/Contents/MacOS/Termorc"
cp Resources/Info.plist "$out/Contents/Info.plist"
cp -R Resources/shell-integration "$out/Contents/Resources/shell-integration"
cp Resources/icons/icon.icns "$out/Contents/Resources/icon.icns"
cp Resources/mark.png "$out/Contents/Resources/mark.png"

# macOS 26 draws the Dock icon from the Icon Composer document (light, dark, clear and tinted
# looks). Compiling it needs Xcode 26's actool; without it every version uses icon.icns.
if xcrun --find actool >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  if xcrun actool Resources/icons/AppIcon.icon --compile "$tmp" --app-icon AppIcon --platform macosx \
      --minimum-deployment-target 14.0 --output-partial-info-plist "$tmp/partial.plist" </dev/null >/dev/null 2>&1; then
    cp "$tmp/Assets.car" "$out/Contents/Resources/Assets.car" 2>/dev/null || true
  fi
  rm -rf "$tmp"
fi

codesign --force --sign - --timestamp=none "$out" >/dev/null
echo "$out"

if [[ "${2:-}" == run ]]; then
  open -n "$out" --env TERMORC_DATA_DIR="${TERMORC_DATA_DIR:-}"
fi
