#!/usr/bin/env bash
# Build + test on a simulator, archive for device, and check the archive's signature and display name.
# Usage (from the repo root): scripts/verify.sh    SIMULATOR="iPhone 16" scripts/verify.sh
# Never passes -allowProvisioningUpdates: it must not touch the Apple account.
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEME="Socialite-Wrapper"
SIMULATOR="${SIMULATOR:-iPhone 17}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/Glance.xcarchive"
APP="$ARCHIVE/Products/Applications/$SCHEME.app"

# step <name> <command...>: one PASS/FAIL line; on failure show the log tail and stop.
STEP=0
step() {
  local name="$1" log="$TMP/step$((++STEP)).log"; shift
  if "$@" > "$log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name"; tail -n 30 "$log"; exit 1
  fi
}

check_archive() {
  codesign --verify --strict "$APP"
  local team
  team="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [[ -n "$team" && "$team" != "not set" ]] || { echo "TeamIdentifier not set"; return 1; }
  local name
  name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$APP/Info.plist")"
  [[ "$name" == "Glance" ]] || { echo "CFBundleDisplayName is '$name', expected 'Glance'"; return 1; }
}

step "build-and-test ($SIMULATOR)" xcodebuild -scheme "$SCHEME" -derivedDataPath "$TMP/dd" \
  -destination "platform=iOS Simulator,name=$SIMULATOR" build test
step "archive (generic/platform=iOS)" xcodebuild -scheme "$SCHEME" -derivedDataPath "$TMP/dd" \
  -destination "generic/platform=iOS" -archivePath "$ARCHIVE" archive
step "archive-signature-and-name" check_archive
