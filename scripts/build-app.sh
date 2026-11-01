#!/usr/bin/env bash
# Builds the native app and wraps it in Termorc.app.
#   scripts/build-app.sh            debug build  → .build/Termorc.app
#   scripts/build-app.sh release    release build → .build/release-app/Termorc.app
#   scripts/build-app.sh debug run  build, then open it (TERMORC_DATA_DIR is passed through)
set -euo pipefail
cd "$(dirname "$0")/.."

config="${1:-debug}"
version="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
version="${version:-2.0.0}"

swift build -c "$config" --product Termorc
bin="$(swift build -c "$config" --show-bin-path)/Termorc"

out=".build/Termorc.app"
[[ "$config" == release ]] && out=".build/release-app/Termorc.app"
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin" "$out/Contents/MacOS/Termorc"
sed "s/__VERSION__/$version/g" Resources/Info.plist > "$out/Contents/Info.plist"
cp -R Resources/shell-integration "$out/Contents/Resources/shell-integration"
cp src-tauri/icons/icon.icns "$out/Contents/Resources/icon.icns"
cp Resources/mark.png "$out/Contents/Resources/mark.png"

# macOS 26 draws the Dock icon from the Icon Composer document (light, dark, clear and tinted
# looks). Compiling it needs Xcode 26's actool; without it every version uses icon.icns.
if xcrun --find actool >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  if xcrun actool src-tauri/icons/AppIcon.icon --compile "$tmp" --app-icon AppIcon --platform macosx \
      --minimum-deployment-target 14.0 --output-partial-info-plist "$tmp/partial.plist" </dev/null >/dev/null 2>&1; then
    cp "$tmp/Assets.car" "$out/Contents/Resources/Assets.car" 2>/dev/null || true
  fi
  rm -rf "$tmp"
fi

# The desktop widgets (Sources/TermorcWidgets): a WidgetKit extension in Contents/PlugIns.
swift build -c "$config" --product TermorcWidgets
appex="$out/Contents/PlugIns/TermorcWidgets.appex"
mkdir -p "$appex/Contents/MacOS" "$appex/Contents/Resources"
cp "$(dirname "$bin")/TermorcWidgets" "$appex/Contents/MacOS/TermorcWidgets"
sed "s/__VERSION__/$version/g" Resources/widgets/Info.plist > "$appex/Contents/Info.plist"
cp Resources/widgets/github.svg Resources/widgets/localhost.png Resources/widgets/vscode.png "$appex/Contents/Resources/"

# The widgets' buttons are App Intents, which WidgetKit finds through Metadata.appintents.
# Xcode builds it from the compiler's constant values; this does the same with its tools.
if xcrun --find appintentsmetadataprocessor >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  sources=("$PWD"/Sources/TermorcWidgets/*.swift)
  echo '["AppIntent","EntityQuery","AppEntity","TransientEntity","AppEnum","AppShortcutProviding","AppShortcutsProvider","AnyResolverProviding","AppIntentsPackage","DynamicOptionsProvider"]' > "$tmp/protocols.json"
  if xcrun swiftc -parse-as-library -wmo -swift-version 5 -module-name TermorcWidgets -target "$(uname -m)-apple-macos14.0" \
      -I "$(dirname "$bin")/Modules" -c "${sources[@]}" -o "$tmp/widgets.o" \
      -emit-const-values-path "$tmp/TermorcWidgets.swiftconstvalues" -Xfrontend -const-gather-protocols-file -Xfrontend "$tmp/protocols.json" >/dev/null; then
    printf '%s\n' "${sources[@]}" > "$tmp/sources.txt"
    echo "$tmp/TermorcWidgets.swiftconstvalues" > "$tmp/constvalues.txt"
    xcrun appintentsmetadataprocessor --output "$appex/Contents/Resources" \
      --toolchain-dir "$(dirname "$(dirname "$(dirname "$(xcrun --find swiftc)")")")" --sdk-root "$(xcrun --show-sdk-path)" \
      --xcode-version "$(xcodebuild -version | awk '/Build version/ {print $3}')" --platform-family macOS --deployment-target 14.0 \
      --target-triple "$(uname -m)-apple-macos14.0" --module-name TermorcWidgets \
      --source-file-list "$tmp/sources.txt" --swift-const-vals-list "$tmp/constvalues.txt" --force >/dev/null 2>&1 ||
      echo "warning: App Intents metadata failed; widget buttons won't respond" >&2
  else
    echo "warning: couldn't extract App Intents constants; widget buttons won't respond" >&2
  fi
  rm -rf "$tmp"
fi
codesign --force --sign - --timestamp=none --entitlements Resources/widgets/TermorcWidgets.entitlements "$appex" >/dev/null

codesign --force --sign - --timestamp=none "$out" >/dev/null
echo "$out"

if [[ "${2:-}" == run ]]; then
  open -n "$out" --env TERMORC_DATA_DIR="${TERMORC_DATA_DIR:-}"
fi
