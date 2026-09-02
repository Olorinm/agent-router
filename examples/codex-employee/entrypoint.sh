#!/bin/sh
set -eu

umask 077
mkdir -p "${CODEX_HOME}"
if [ ! -s "${CODEX_HOME}/auth.json" ]; then
  echo "Codex authentication is missing at ${CODEX_HOME}/auth.json" >&2
  exit 1
fi
chmod 600 "${CODEX_HOME}/auth.json"
exec node /app/dist/index.js
