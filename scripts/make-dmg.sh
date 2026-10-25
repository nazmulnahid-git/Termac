#!/bin/sh
# Packs the built Termorc.app into a styled installer disk image.
# Needs dmgbuild: pip3 install dmgbuild
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
bundle=src-tauri/target/release/bundle
mkdir -p "$bundle/dmg"
out="$bundle/dmg/Termorc_${version}_$(uname -m).dmg"
${DMGBUILD:-dmgbuild} -s scripts/dmg-settings.py \
  -D app="$bundle/macos/Termorc.app" \
  -D background="build/dmg/background.tiff" \
  "Termorc" "$out"
echo "$out"
