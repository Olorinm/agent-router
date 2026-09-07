#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose -f deploy/matrix/compose.lab.yaml)
check() { "${compose[@]}" run --rm check node scripts/matrix/lab-check.mjs "$1"; }
trap '"${compose[@]}" start connector-b >/dev/null' EXIT
check basic
check cancel-pending
"${compose[@]}" stop connector-b
check queue-offline
"${compose[@]}" start connector-b
check verify-offline
"${compose[@]}" restart connector-a connector-b agent-a agent-b
check verify-restart
"${compose[@]}" stop connector-b
check queue-cancel
"${compose[@]}" start connector-b
check verify-cancel
"${compose[@]}" stop connector-b
check gap-fill
"${compose[@]}" start connector-b
check verify-gap
echo 'Matrix federation conformance completed. Evidence: state/matrix-lab/verification.json'
