#!/usr/bin/env bash
# Builds the macOS desktop installers (Apple silicon + Intel) on this Mac and attaches them to a GitHub release.
#   scripts/release-macos.sh [tag]      tag defaults to v<version in tauri.conf.json>
#   scripts/release-macos.sh --ios      also build an unsigned iOS .ipa (for sideloading, see below)
#   scripts/release-macos.sh --no-intel | --no-arm     skip one desktop architecture
#   scripts/release-macos.sh --dry-run  build and list the files, but upload nothing
# Run it after scripts/release.sh has created the draft release for the same tag (if there is none, a draft is created).
# Needs: macOS, Xcode command line tools, rustup, Node, gh (logged in), apps/desktop/.env (and apps/mobile/.env,
# Flutter, Xcode and CocoaPods for --ios).
# Builds are ad-hoc signed (tauri.conf.json bundle.macOS.signingIdentity "-"), not notarized: users get the Gatekeeper
# "Open Anyway" step described in the README. The Intel build is cross-compiled with the Rust target
# x86_64-apple-darwin (Xcode builds both architectures); to run it here you would need Rosetta.
# The iOS .ipa is unsigned: it installs only through a sideloading tool (AltStore, Sideloadly) that re-signs it with a
# free Apple ID (re-sign every 7 days). TestFlight / App Store / ad-hoc distribution needs the paid developer program.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD

[ "$(uname -s)" = Darwin ] || { echo "This script must run on macOS." >&2; exit 1; }

arm=1 intel=1 ios=0 dry=0 tag=""
for a in "$@"; do
  case "$a" in
    --no-arm) arm=0 ;;
    --no-intel) intel=0 ;;
    --ios) ios=1 ;;
    --dry-run) dry=1 ;;
    -*) echo "Unknown option $a" >&2; exit 1 ;;
    *) tag="$a" ;;
  esac
done

command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
[ "$dry" = 1 ] || command -v gh >/dev/null || { echo "gh (GitHub CLI) is required" >&2; exit 1; }
command -v rustup >/dev/null || { echo "rustup is required" >&2; exit 1; }
[ -f apps/desktop/.env ] || { echo "Missing apps/desktop/.env" >&2; exit 1; }

version=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
tag=${tag:-v$version}
[ "$tag" = "v$version" ] || echo "warning: tag $tag does not match the app version $version" >&2

if [ "$dry" = 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree has uncommitted changes; commit them first so the build matches the tag." >&2
    exit 1
  fi
  git fetch -q
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{upstream}' 2>/dev/null || echo none)" ]; then
    echo "HEAD is not the same as the pushed upstream; git pull / git push first." >&2
    exit 1
  fi
fi

npm ci
files=()
build_target() {
  local target=$1 suffix=$2
  rustup target add "$target"
  (cd apps/desktop && npm run tauri build -- --target "$target")
  files+=("apps/desktop/src-tauri/target/$target/release/bundle/dmg/Texture_${version}_${suffix}.dmg")
}
[ "$arm" = 1 ] && build_target aarch64-apple-darwin aarch64
[ "$intel" = 1 ] && build_target x86_64-apple-darwin x64

if [ "$ios" = 1 ]; then
  [ -f apps/mobile/.env ] || { echo "Missing apps/mobile/.env" >&2; exit 1; }
  (cd apps/mobile && flutter pub get && flutter build ios --release --no-codesign --dart-define-from-file=.env)
  stage=$(mktemp -d)
  mkdir "$stage/Payload"
  cp -R apps/mobile/build/ios/iphoneos/Runner.app "$stage/Payload/"
  ipa="$root/apps/mobile/build/Texture-$tag-unsigned.ipa"
  rm -f "$ipa"
  (cd "$stage" && zip -qry "$ipa" Payload)
  rm -rf "$stage"
  files+=("$ipa")
fi

for f in "${files[@]}"; do [ -f "$f" ] || { echo "Expected build output missing: $f" >&2; exit 1; }; done

if [ "$dry" = 1 ]; then
  echo "Dry run: would upload to $tag:"; printf '  %s\n' "${files[@]}"
  exit 0
fi
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" --clobber "${files[@]}"
else
  gh release create "$tag" --draft --title "Texture $tag" --target "$(git rev-parse HEAD)" --generate-notes "${files[@]}"
fi
echo "Attached to release $tag. Review and publish it on GitHub."
