# Sourced by the release scripts (from the repo root): loads .env.release if it exists. The file is gitignored
# (.env*) and is read as shell, so quote values with spaces. Anything already exported in the environment wins over
# the file, so a one-off `VAR=... scripts/release-....sh` still works. See .env.release.example.
if [ -f .env.release ]; then
  __saved_env=$(export -p)
  set -a
  # shellcheck disable=SC1091
  . ./.env.release
  set +a
  # A blank entry means "not set": tools such as Tauri's notarization treat a set-but-empty variable as given.
  for __v in $(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' .env.release); do
    [ -z "${!__v:-}" ] && unset "$__v"
  done
  unset __v
  eval "$__saved_env"
  unset __saved_env
fi
