#!/usr/bin/env bash
# Builds the web version into build/web with Supabase settings from apps/mobile/.env.
# Serve that folder from any static host. Its address (e.g. https://texture.example.com/)
# must be listed under Authentication → URL Configuration → Redirect URLs in Supabase,
# or confirm/reset links can't return to it. Serving from a sub-path needs --base-href /path/.
# Extra arguments go to `flutter build web`. For local testing: ./run.sh -d chrome
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing apps/mobile/.env (copy .env.example and fill it in)" >&2; exit 1; }
command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
exec flutter build web --wasm --dart-define-from-file=.env "$@"
