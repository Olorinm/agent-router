#!/bin/sh
set -eu

umask 077
mkdir -p "${CODEX_HOME}"
cp /run/secrets/codex_auth "${CODEX_HOME}/auth.json"
chmod 600 "${CODEX_HOME}/auth.json"
exec node /app/dist/index.js
