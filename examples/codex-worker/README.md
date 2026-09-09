# Supervised Codex worker

An optional host adapter for an already authenticated Codex CLI. It uses the public
`agent-router claim/work/progress/reply/fail/cancelled` commands and does not bind an
A2A execution server. The regular connector still runs separately.

Set `CONNECTOR_URL`, `CONNECTOR_API_TOKEN_FILE`, `CODEX_HOME`, `WORKER_STATE_DIR`
and `WORKER_WORKSPACE_DIR`, then run `node worker.mjs` with Node 24. The CLI and
Codex executable must be on PATH, or selected with `AGENT_ROUTER_BIN` and `CODEX_BIN`.
`WORKER_NAME` defaults to `codex-service`; keep it stable across restarts.
`CODEX_MODEL` is optional; otherwise Codex selects its default model.

`WORKER_PROJECTS_DIR` optionally identifies shared, persistent project checkouts.
The Compose deployment mounts `state/projects` at `/projects`; prepare this
directory with UID 1000 ownership before starting. Every conversation is told where
these projects live and to preserve existing changes and follow repository
instructions. The image includes Git. Shared checkouts are writable by the private
service, so independently concurrent workers should use separate worktrees.

Each sender/conversation pair maps to a persisted Codex session and workspace.
Follow-up requests use `codex exec resume`. Progress and terminal results flow
through the connector. The worker stops active Codex process groups on cancellation
or an execution timeout. Compose defaults to 30 minutes; set `CODEX_TIMEOUT_MS` in
the operator's `.env` to change it. A standalone worker without this setting keeps
its four-minute default. This limit is independent of the caller's `send --wait`:
ending a CLI wait does not cancel the remote work. A restart between requests preserves context; interrupted
work is explicitly failed instead of silently replayed. Completed output is saved
before publishing, so a delivery retry does not rerun the model.

The sample is intended for a private, explicitly approved caller. Put it in an
isolated non-root container, mount only its own state/workspace/credentials, and
keep the gateway private. Conversation directories provide organization, not a
security boundary between mutually untrusted tenants. Do not mount a Docker socket,
host SSH keys, or unrelated application data. No public anonymous execution policy
is enabled by this worker.

Outside the supplied deployment, the worker uses Codex's `workspace-write` sandbox.
The Compose deployment explicitly sets `CODEX_CONTAINER_ISOLATION=1`: Codex uses
`danger-full-access` **inside the non-root container**, and Docker supplies the
boundary (read-only root filesystem, dropped capabilities, no host tools/socket,
only this service's writable state). This supports hosts that prohibit nested
Bubblewrap namespaces without changing host security settings. The worker refuses
this option outside a non-root Docker container. Do not enable it for an ordinary
host process or a public service handling mutually untrusted users.

The Dockerfile accepts two operator-provided image references: `ROUTER_IMAGE`
contains the built current project (`/app/bin/agent-router`), and `CODEX_IMAGE`
contains the official Codex npm packages under `/app/node_modules/@openai`.
Preserve the worker database, Codex home, connector database and workspaces when
restarting. This example does not change the default CLI's model lifecycle.

For `compose.yaml`, prepare `state/profiles/receiver/session.json` using CLI
registration/login, retaining its refresh token. The profile's connector URL stays
`http://127.0.0.1:8787`. The worker shares the connector's network namespace, with no
published port; only the connector mounts the Matrix profile. Put the profile's
gateway token in `secrets/gateway` (mode 0600), and give all state directories to
the image's `node` user (UID 1000, directories 0700). Mount an authenticated,
dedicated Codex home at `state/codex`. Never put credentials in the image.

Set `ROUTER_IMAGE`, `CODEX_IMAGE`, `CODEX_PROXY_NETWORK` and, if needed,
`CODEX_PROXY_URL` in the operator's `.env`. The egress network must already exist;
it can be a dedicated network without a proxy when direct access works. Then:

```sh
docker compose up -d --build
docker compose exec connector agent-router doctor
docker compose exec connector agent-router contact-add '@owner:agents.example' \
  --allow-receive --allow-execution
```

Wait for `doctor` to report `ready` before adding the approved caller. Permissions
persist in the connector profile. Do not extract a short-lived Matrix access token
into a static environment variable: the profile client refreshes credentials and
saves their replacements. Stop both services before moving the profile to another
host; only one execution connector should own it.

The caller uses normal `send/get/cancel` commands. Send subsequent requests with
the returned `--context-id` to resume the same Codex session. Omitting it creates a
fresh Codex session. Use `docker compose restart` between requests to verify
recovery; do not replace or remove the persisted directories.

Replies over 12 KB are retained in the remote workspace and returned as an
explicit excerpt, so an oversized response does not leave delivery retrying
indefinitely. Ask for a selected section in the same conversation to retrieve it.

## Managed Agent instance

For the current managed architecture, the owner creates/selects an Agent and runs
`agent-instance-create NAME --out instance.json`. Use `compose.managed.yaml` to run
only the worker; no Matrix connector/account is installed on this machine.
Set `AGENT_GATEWAY_URL` to the exported service URL plus `/agents/<agent.id>/gateway`,
put the exported `token` in the private `secrets/instance-token` file, and make it
readable only by the worker container's UID. Keep the owner session and AS secrets off this host.

The existing `ROUTER_IMAGE`, `CODEX_IMAGE`, proxy/network settings and Codex auth are
still required. The managed Compose uses separate `state/managed-worker` and
`state/managed-workspaces` directories, while reusing `state/projects` and `state/codex`.
Run `docker compose -f compose.managed.yaml up -d --build`. Give each independently
running worker its own instance credential and persistent state; never duplicate
an active instance. The gateway handles task assignment, while this adapter retains
Codex session mappings and checks for cancellation. `connect` by itself does not start Codex.

## Connection failures

Model transport retries are reported through task progress. A failed TLS handshake,
connection, or timeout produces a clear terminal connection error if Codex cannot
recover; a successful retry still delivers the normal answer. Only fixed status
messages and diagnostic categories are published, never raw provider diagnostics.
Run `npm run test:codex-worker` to verify failure and recovery through the worker's
CLI boundaries.

A healthy worker heartbeat only confirms that its loop is alive. Validate model
connectivity as well. If the host uses a rule-based egress proxy, place the model
service's domain routes before IP-based direct-routing rules: a misleading DNS
answer must not send model traffic to the direct route.

For a worker-only update, `Dockerfile.update` accepts an existing verified
`WORKER_IMAGE` reference. It replaces only `worker.mjs`, preserving the installed
Codex/CLI versions and container defaults. Build to a new image tag and retain
the previous image for rollback; use the full Dockerfile for dependency changes.
