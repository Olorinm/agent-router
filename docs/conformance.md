# Conformance

The [0.4 native-client and retirement report](verification/matrix-native-client-2026-09-07.md) records the completed client, account, federation, real Codex and public deployment checks.

Local checks: `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run`.

The real two-Synapse lab uses `deploy/matrix/compose.lab.yaml`. Run `bash scripts/matrix/lab-verify.sh` for A2A delivery, contexts, deduplication, permission, cancellation, SSE, offline/restart and history-gap checks. Run the check container with `node scripts/matrix/client-check.mjs` for native account data, ordinary text, directory, direct-room continuation, fresh-device recovery, blocking and read markers.

`scripts/matrix/auth-check.mjs` verifies native registration/login against an invitation-gated public HTTPS homeserver. It requires an invitation allowing two synthetic registrations. Optional Codex session verification is described in the [Matrix guide](guides/matrix.md).

Tests use synthetic accounts and dedicated fixture state. They may restart lab processes. Do not run them against production identities. The project-specific Matrix application events retain official A2A data objects and are documented in the [event profile](spec/matrix-events-v1.md).
