#!/usr/bin/env bash
# Builds the iOS app on this Mac, signed for the App Store, and uploads it to App Store Connect. It then appears in
# TestFlight; submitting it for review is done on the App Store Connect site. (The desktop app is not in the Mac
# App Store: it ships as a notarized DMG from scripts/release-macos.sh.)
#   scripts/release-appstore.sh               build and upload
#   scripts/release-appstore.sh --no-upload   build only; leaves the .ipa in apps/mobile/build/ios/ipa/
#
# One-time setup:
#   - Developer portal (https://developer.apple.com/account): register dev.texture.textureMobile as an App ID, and
#     create the app in App Store Connect.
#   - Signing is automatic: open apps/mobile/ios/Runner.xcworkspace once, Runner → Signing & Capabilities, pick your
#     team (Xcode creates the Apple Distribution certificate and profile when needed).
#   - Upload key: App Store Connect → Users and Access → Integrations → App Store Connect API, a key with the
#     App Manager role. Save AuthKey_<KEY ID>.p8 in ~/.appstoreconnect/private_keys/.
#
# Variables below can also go in .env.release at the repo root (gitignored; see .env.release.example).
# Environment:
#   ASC_KEY_ID           the API key id, and
#   ASC_ISSUER_ID        its issuer id (both required unless --no-upload)
#   BUILD_NUMBER         default: the current time (yymmddHHMM), so every upload is higher than the last
# Needs: macOS, Xcode, Flutter, CocoaPods and apps/mobile/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/release-env.sh

[ "$(uname -s)" = Darwin ] || { echo "This script must run on macOS." >&2; exit 1; }

upload=1
for a in "$@"; do
  case "$a" in
    --no-upload) upload=0 ;;
    *) echo "Unknown option $a" >&2; exit 1 ;;
  esac
done

command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
build=${BUILD_NUMBER:-$(date +%y%m%d%H%M)}
if [ "$upload" = 1 ]; then
  : "${ASC_KEY_ID:?Set ASC_KEY_ID and ASC_ISSUER_ID (App Store Connect API key), or pass --no-upload}"
  : "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
fi
[ -n "$(git status --porcelain)" ] && echo "warning: the working tree has uncommitted changes; they go into this build" >&2
[ -f apps/mobile/.env ] || { echo "Missing apps/mobile/.env" >&2; exit 1; }
grep -q "DEVELOPMENT_TEAM" apps/mobile/ios/Runner.xcodeproj/project.pbxproj \
  || { echo "No signing team set: open apps/mobile/ios/Runner.xcworkspace, Runner → Signing & Capabilities, pick your team." >&2; exit 1; }

rm -rf apps/mobile/build/ios/ipa
(cd apps/mobile && flutter pub get && flutter build ipa --release --build-number="$build" --dart-define-from-file=.env)
ipas=(apps/mobile/build/ios/ipa/*.ipa)
ipa=${ipas[0]}
[ -f "$ipa" ] || { echo "Expected build output missing: apps/mobile/build/ios/ipa/*.ipa" >&2; exit 1; }

if [ "$upload" = 0 ]; then echo "Built (not uploaded): $ipa"; exit 0; fi
# Apple's automated checks first (signing, Info.plist, icons), then the upload.
xcrun altool --validate-app -t ios -f "$ipa" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
xcrun altool --upload-app -t ios -f "$ipa" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
echo "Uploaded $ipa (build $build). It shows in App Store Connect / TestFlight once processing finishes."
