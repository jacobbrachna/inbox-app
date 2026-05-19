#!/usr/bin/env bash
# Renames the dev Electron binary to "Relay" so the macOS menu bar shows
# "Relay" instead of "Electron" while developing. Gets clobbered on every
# `npm install` of electron — this script is idempotent, so just re-run.
# Production .app builds use CFBundleName from electron-builder.yml's
# productName and don't need this.

set -e
PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0
/usr/libexec/PlistBuddy -c "Set :CFBundleName Relay" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Relay" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Relay" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Relay" "$PLIST"

# LaunchServices caches the bundle name on first launch. Force it to
# re-read by touching the .app and re-registering it. Without this,
# the macOS Dock keeps showing "Electron" in the tooltip even though
# Info.plist says Relay.
APP="node_modules/electron/dist/Electron.app"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
  -f -v "$APP" > /dev/null 2>&1 || true
