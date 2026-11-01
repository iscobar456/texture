#!/usr/bin/env bash
# Runs the app with Supabase settings from apps/mobile/.env. Extra arguments go to `flutter run`,
# e.g. ./run.sh -d <device-id>   or   ./run.sh --release
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing apps/mobile/.env (copy .env.example and fill it in)" >&2; exit 1; }
command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
exec flutter run --dart-define-from-file=.env "$@"
