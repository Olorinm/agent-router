#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test -f state/matrix-lab/initialized.json
if [ "${MANAGED_SKIP_BUILD:-}" != 1 ]; then docker build -t agent-router-matrix:managed .; fi
for side in a b; do
  docker run --rm --user 0 -v "$PWD":/deployment -w /deployment \
    -e "MATRIX_SYNAPSE_DIR=state/matrix-lab/synapse-$side" \
    -e "AGENT_SERVICE_STATE=state/matrix-lab/managed-$side" \
    -e "AGENT_SERVICE_SECRETS=state/matrix-lab/as-secrets-$side" \
    -e "AGENT_SERVICE_INTERNAL_URL=http://agent-service-$side:8790" \
    agent-router-matrix:managed node scripts/matrix/agent-service-init.mjs
done
compose=(docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.managed.lab.yaml)
"${compose[@]}" restart synapse-a synapse-b
"${compose[@]}" up -d --wait agent-service-a agent-service-b
"${compose[@]}" run --rm check node scripts/matrix/managed-lab-check.mjs
