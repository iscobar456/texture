#!/usr/bin/env bash
# Builds the Linux desktop bundles and the Android APK on this machine and attaches them to a draft GitHub release.
#   scripts/release.sh [tag]        tag defaults to v<version in tauri.conf.json>
#   scripts/release.sh --no-android | --no-desktop     build only one side
#   scripts/release.sh --dry-run    build and list the files, but skip the git checks and do not create a release
# Needs: gh (logged in), apps/desktop/.env, apps/mobile/.env, and apps/mobile/android/key.properties (the release
# keystore; without it the APK would be debug-signed and phones could not update over it).
# macOS and Windows are not built here; use the manual Release workflow for those.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD

desktop=1 android=1 dry=0 tag=""
for a in "$@"; do
  case "$a" in
    --no-android) android=0 ;;
    --no-desktop) desktop=0 ;;
    --dry-run) dry=1 ;;
    -*) echo "Unknown option $a" >&2; exit 1 ;;
    *) tag="$a" ;;
  esac
done

[ "$dry" = 1 ] || command -v gh >/dev/null || { echo "gh (GitHub CLI) is required" >&2; exit 1; }
command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"

version=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
tag=${tag:-v$version}
[ "$tag" = "v$version" ] || echo "warning: tag $tag does not match the app version $version" >&2

if [ "$dry" = 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree has uncommitted changes; commit them first so the release matches the tag." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor HEAD "@{upstream}" 2>/dev/null; then
    echo "HEAD is not pushed; run git push first (the tag is created on the remote at HEAD)." >&2
    exit 1
  fi
  gh release view "$tag" >/dev/null 2>&1 && { echo "Release $tag already exists." >&2; exit 1; }
fi

files=()
if [ "$desktop" = 1 ]; then
  [ -f apps/desktop/.env ] || { echo "Missing apps/desktop/.env" >&2; exit 1; }
  npm ci
  (cd apps/desktop && npm run tauri build)
  b=apps/desktop/src-tauri/target/release/bundle
  # Match this version only: old bundles from earlier builds stay in the folder.
  files+=("$b"/deb/*_"$version"_*.deb "$b"/rpm/*-"$version"-*.rpm "$b"/appimage/*_"$version"_*.AppImage)
fi
if [ "$android" = 1 ]; then
  [ -f apps/mobile/.env ] || { echo "Missing apps/mobile/.env" >&2; exit 1; }
  [ -f apps/mobile/android/key.properties ] || { echo "Missing apps/mobile/android/key.properties (release keystore)" >&2; exit 1; }
  export GRADLE_OPTS="${GRADLE_OPTS:-} --enable-native-access=ALL-UNNAMED"
  (cd apps/mobile && flutter pub get && flutter build apk --release --dart-define-from-file=.env)
  apk="apps/mobile/build/Texture-$tag.apk"
  cp apps/mobile/build/app/outputs/flutter-apk/app-release.apk "$apk"
  files+=("$apk")
fi

for f in "${files[@]}"; do [ -f "$f" ] || { echo "Expected build output missing: $f" >&2; exit 1; }; done

if [ "$dry" = 1 ]; then
  echo "Dry run: would create draft release $tag with:"; printf '  %s\n' "${files[@]}"
  exit 0
fi
gh release create "$tag" --draft --title "Texture $tag" --target "$(git rev-parse HEAD)" --generate-notes "${files[@]}"
echo "Draft release $tag created. Review and publish it on GitHub."
