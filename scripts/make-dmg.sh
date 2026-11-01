#!/bin/sh
# Builds the release app and packs it into a styled installer disk image:
#   scripts/make-dmg.sh   → .build/release-app/Termorc_<version>_<arch>.dmg
# Needs dmgbuild: pip3 install dmgbuild
set -e
cd "$(dirname "$0")/.."
app=$(scripts/build-app.sh release | tail -1)
version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" Resources/Info.plist)
out=".build/release-app/Termorc_${version}_$(uname -m).dmg"
${DMGBUILD:-dmgbuild} -s scripts/dmg-settings.py \
  -D app="$app" \
  -D background="Resources/dmg/background.tiff" \
  "Termorc" "$out"
echo "$out"
