# Conformance

`test/sdk-official-interop.test.ts` exercises SDK send, get, streaming updates, cancellation and task errors against the unmodified official A2A `DefaultRequestHandler` and Express JSON-RPC handler. The executor is a deterministic fixture; this verifies the A2A boundary, not live Matrix federation or model behavior. `test/sdk-identity.test.ts` separately exercises the Router gateway and durable connector with a simulated Matrix transport.

The [0.6 Go CLI report](verification/go-cli-2026-09-07.md) covers the standalone binary, Go/TypeScript boundary and actual Go CLI conformance runs.

The [0.5 CLI execution report](verification/matrix-cli-work-2026-09-07.md) verifies both peers using the CLI without A2A execution servers. Run the lab check container with `node scripts/matrix/cli-work-check.mjs`: it creates two synthetic accounts and launches only their connectors, then checks approval, exclusive claims, progress/results, input continuation, cancellation and restart/offline recovery.

The [0.4 native-client and retirement report](verification/matrix-native-client-2026-09-07.md) records the completed client, account, federation, real Codex and public deployment checks.

Local checks: `go test -race ./...`, `go vet ./...`, `sh scripts/build-cli.sh`, `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run`. Build the Go binary before `npm test`: the suite runs it against the TypeScript gateway with Node removed from its PATH. Account and profile-lock checks cover both languages. All three CLI conformance scripts now invoke `bin/agent-router` (override with `AGENT_ROUTER_CLI`) and keep Node only for the communication service and test fixtures.

The real two-Synapse lab uses `deploy/matrix/compose.lab.yaml`. Run `bash scripts/matrix/lab-verify.sh` for A2A delivery, contexts, deduplication, permission, cancellation, SSE, offline/restart and history-gap checks. Run the check container with `node scripts/matrix/client-check.mjs` for native account data, ordinary text, directory, direct-room continuation, fresh-device recovery, blocking and read markers.

The private lab raises message, invitation and join burst allowances for repeated synthetic runs. For an already initialized lab, set `rc_joins.local` and `rc_joins.remote` to `{ "per_second": 100, "burst_count": 1000 }` in each private lab `homeserver.yaml`, then restart those two Synapse containers. Keep the existing keys, accounts and databases. These test allowances are not applied to the public homeserver; normal [Synapse join limits](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_joins) can delay a burst of new cross-server conversations.

`scripts/matrix/auth-check.mjs` verifies native registration/login against an invitation-gated public HTTPS homeserver. It requires an invitation allowing two synthetic registrations. Optional Codex session verification is described in the [Matrix guide](guides/matrix.md).

Tests use synthetic accounts and dedicated fixture state. They may restart lab processes. Do not run them against production identities. The project-specific Matrix application events retain official A2A data objects and are documented in the [event profile](spec/matrix-events-v1.md).
