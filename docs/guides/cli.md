# Agent Router CLI

`agent-router` is a standalone, provider-neutral client for people, scripts, and agents. It uses Router-owned HTTP endpoints only for discovery, enrollment, and directory administration. Messages and Tasks go through the official A2A Go SDK.

## Install

Download the archive for your operating system and architecture from [GitHub Releases](https://github.com/Olorinm/agent-router/releases), verify the adjacent SHA-256 file, and place `agent-router` on `PATH`.

To build from source:

```sh
cd cli
go build -o agent-router ./cmd/agent-router
```

The CLI requires no Node.js runtime and does not contain a Router server.

## Profiles and authentication

A profile is the equivalent of a homeserver selection. Discovery reads `/.well-known/agent-router`, verifies the returned base URL, and stores only non-secret location data.

```sh
agent-router profile add work agents.example.com
agent-router profile list
agent-router profile use work
agent-router doctor
```

Administrator access currently accepts a bearer token through stdin. The token is verified before being written to the operating-system credential store.

```sh
printf '%s' "$ADMIN_TOKEN" | agent-router auth login --token-stdin
agent-router whoami
agent-router auth status
agent-router auth logout
```

No command accepts a secret as a normal flag. `AGENT_ROUTER_TOKEN` is a process-level override intended for CI and headless containers.

## Enroll an agent

An administrator creates a short-lived, one-use token. Restrict both the requested address and endpoint origin whenever possible.

```sh
agent-router admin enrollment create \
  --address writer \
  --endpoint-origin https://worker.example.net \
  --expires-in 900 \
  --label onboarding-writer
```

The worker operator exposes an A2A v1 Agent Card, validates it, and consumes the token:

```sh
agent-router agent validate https://worker.example.net/.well-known/agent-card.json

printf '%s' "$ENROLLMENT_TOKEN" | agent-router agent register \
  --address writer \
  --card https://worker.example.net/.well-known/agent-card.json \
  --enrollment-token-stdin
```

If the worker endpoint itself requires a bearer token, provide it only through `AGENT_ENDPOINT_TOKEN` for this invocation. The Router encrypts it at rest and never publishes it in the Router-owned Card.

By default the returned Router machine credential is stored in the OS credential store and selected as the active identity. In a clean container without a system keychain, capture it explicitly:

```sh
printf '%s' "$ENROLLMENT_TOKEN" | agent-router --json agent register \
  --address writer \
  --card https://worker.example.net/.well-known/agent-card.json \
  --enrollment-token-stdin \
  --no-store
```

Then pass the captured value as `AGENT_ROUTER_TOKEN` to later commands.

Enrollment tokens are hashed at rest, expire automatically, and are consumed in the same database transaction that creates the registration. A concurrent second use cannot create a second agent.

## Find and call agents

The directory is authenticated. It searches only active local registrations and returns Router-owned Cards, never real endpoint credentials.

```sh
agent-router directory search writing
agent-router directory show writer@agents.example.com
agent-router send writer@agents.example.com "Draft an introduction."
agent-router send writer@agents.example.com "Draft an introduction." --wait
```

`send` creates an official A2A Message. Use a stable client-generated ID when retrying the same logical request:

```sh
agent-router send writer@agents.example.com "Draft an introduction." \
  --message-id 019example-stable-id
```

The Router and federated Routers use `messageId` as the idempotency key. Do not generate a new ID for a transport retry.

## Tasks

After `send` returns a Task, the CLI remembers the target address locally so the Task can be addressed by ID alone:

```sh
agent-router task get TASK_ID
agent-router task watch TASK_ID --ndjson
agent-router task list --agent writer@agents.example.com
agent-router task cancel TASK_ID --yes
```

Add `--agent ADDRESS` if the Task was created by another client or the local mapping is unavailable. All four operations use official A2A Task methods.

## Credential lifecycle

An administrator or the agent itself can list non-secret metadata, create another credential, revoke one credential, or atomically replace every active credential:

```sh
agent-router agent credential list writer@agents.example.com
agent-router agent credential create writer@agents.example.com --label deploy-2 --activate
agent-router agent credential revoke writer@agents.example.com CREDENTIAL_ID --yes
agent-router agent credential rotate writer@agents.example.com --label quarterly --yes
```

Revocation and expiration take effect on the next request; machine credentials are deliberately not cached by the Router.

## Automation contract

- stdout contains results; diagnostics and warnings use stderr;
- `--json` emits one JSON document;
- `task watch --ndjson` emits one Task per state transition;
- destructive or trust-changing operations require `--yes`;
- `agent-router schema [COMMAND]` prints compact machine-readable command contracts;
- exit status is non-zero on discovery, authentication, validation, HTTP, or A2A errors.

`agent-router link --agent ADDRESS` writes a non-secret `.agent-router.json` association for the current directory. The file is ignored by this repository and is never used as a credential store.
