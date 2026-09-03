# Agent Router CLI

`agent-router` is a standalone, provider-neutral client for people, scripts, and agents. The ordinary path has four verbs: log in, invite, join, and send. Router profiles, enrollment records, credential rotation, and raw JSON remain available for operators and automation without being prerequisites for first use.

Messages and Tasks use the official A2A Go SDK. Router-specific HTTP is limited to discovery, enrollment, directory, and administration.

## Install

On macOS or Linux with Homebrew:

```sh
brew install Olorinm/tap/agent-router
```

With Go:

```sh
go install github.com/Olorinm/agent-router/cli/cmd/agent-router@latest
```

Signed release metadata, platform archives, and adjacent SHA-256 files are available on [GitHub Releases](https://github.com/Olorinm/agent-router/releases). The CLI is a single binary and does not require Node.js or a local Router checkout.

## Log in once

Give the CLI a Router domain. It discovers the service through `/.well-known/agent-router`, makes it current, prompts for the administrator credential without echoing it, verifies the identity, and stores the credential in the operating-system credential store.

```sh
agent-router login agents.example.com
```

Multiple Router profiles are an advanced feature:

```sh
agent-router profile add staging staging.agents.example.com
agent-router profile use staging
agent-router doctor
```

## Invite an agent

The administrator supplies the desired address and the agent endpoint. A short-lived invitation is shown once. The endpoint is reduced to its HTTPS origin and bound into the enrollment so the invitation cannot be used to register a different endpoint.

```sh
agent-router invite writer worker.example.net
```

Send the resulting `arj1_...` invitation to the worker operator through a private channel.

## Join from the agent machine

The worker operator runs one command:

```sh
agent-router join
```

The CLI privately prompts for the invitation and then asks for the A2A Agent Card URL. It discovers the invitation's Router, validates the Card, registers the agent, stores the returned machine credential, and selects that agent identity. Neither the invitation nor the machine credential is placed in shell history.

For a conventional Card location, the interaction looks like this:

```text
One-time invitation: [hidden]
Agent Card URL: https://worker.example.net/.well-known/agent-card.json
Joined as writer@agents.example.com
```

If the real agent endpoint requires a bearer token, set `AGENT_ENDPOINT_TOKEN` only for the `join` invocation. The Router encrypts it at rest and never publishes it in the Router-owned Card.

## Find and call agents

```sh
agent-router find writing
agent-router send writer "Draft a two-sentence introduction."
```

Local addresses may use only the localpart (`writer`); federated addresses remain explicit (`writer@another.example`). `send` waits for the terminal A2A Task by default and prints its text result. Use `--detach` when only Task acceptance is needed:

```sh
agent-router send writer "Run the long analysis." --detach
```

Use a stable client-generated ID when retrying the same logical request:

```sh
agent-router send writer "Draft an introduction." --message-id 019example-stable-id
```

## Tasks

The CLI remembers which Agent owns each Task, so the ID is normally enough:

```sh
agent-router task get TASK_ID
agent-router task watch TASK_ID --ndjson
agent-router task list --agent writer
agent-router task cancel TASK_ID --yes
```

## Automation and containers

Interactive prompts are the human default. Automation uses environment variables or stdin and structured output:

```sh
AGENT_ROUTER_TOKEN="$ADMIN_TOKEN" agent-router --json invite writer worker.example.net

AGENT_ROUTER_INVITE="$INVITATION" agent-router --json join \
  https://worker.example.net/.well-known/agent-card.json \
  --no-store
```

- stdout contains results; diagnostics and prompts use stderr;
- `--json` emits one JSON document;
- `task watch --ndjson` emits one Task per state transition;
- `agent-router schema [COMMAND]` exposes compact machine-readable command contracts;
- destructive trust changes require `--yes`;
- exit status is non-zero on discovery, authentication, validation, HTTP, or A2A errors.

The lower-level `auth`, `profile`, `admin enrollment`, `directory`, and `agent credential` command groups remain available for operators. They are not part of the ordinary onboarding path.

## Design lineage

- [Vercel CLI](https://vercel.com/docs/cli): short top-level workflow and remembered project/server context;
- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login): interactive human login, secure credential storage, and environment/stdin fallbacks for automation;
- [Matrix server discovery](https://spec.matrix.org/latest/client-server-api/#server-discovery): users provide a domain or identity while the client discovers the actual service URL;
- [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys/): scoped, expiring enrollment authority for unattended machines;
- `lark-cli`: task-level shortcuts for common actions, with typed low-level commands and machine-readable schemas retained as an escape hatch.
