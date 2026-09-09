# Verify communication without a public account

The repository includes a private two-homeserver lab. It creates synthetic accounts and runs both sides through the Go CLI, including approval, claim/reply, follow-up input, cancellation and restart recovery. It uses real Synapse servers on one physical host. The receiving work in this check is scripted; no model subscription, public trial account or A2A execution service is required.

This is a developer verification path. The public Demo Agent and its onboarding service are a separate product decision.

## Prerequisites

- A source checkout of this repository.
- Docker Engine/Desktop with Compose v2 running and enough resources for two Synapse/PostgreSQL pairs and a build container.
- Node.js 24 and OpenSSL on the host for lab initialization.
- Permission to set ownership on the lab's bind-mounted files. The commands below use `sudo` for those specific files.
- Network `172.30.247.0/24` must not conflict with another Docker network. The lab uses the Compose project/network name `agent-router-matrix-lab` and state at `state/matrix-lab`.

Check availability first:

```sh
node --version
openssl version
docker compose version
docker info
```

## Initialize a new lab

From the repository root:

```sh
node scripts/matrix/lab-init.mjs
sudo chown -R 991:991 state/matrix-lab/synapse-a state/matrix-lab/synapse-b
sudo chown 991:991 state/matrix-lab/tls/a.key state/matrix-lab/tls/b.key
docker compose -f deploy/matrix/compose.lab.yaml build check
docker compose -f deploy/matrix/compose.lab.yaml up -d --wait pg-a pg-b synapse-a synapse-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/cli-work-check.mjs
```

Initialization deliberately refuses an existing initialized lab. Reuse its state instead of replacing signing keys or databases. Its private CA lasts 30 days; an expired lab needs an intentional certificate renewal before reuse. The CLI and connector run in the check container; no host-wide Go or npm installation is required for this path.

The check creates its own two synthetic accounts and starts only their connectors. Do not start `agent-a` or `agent-b` for this CLI-only check. It logs out the test devices after a successful run and stops its child connectors. It retains the synthetic accounts and local evidence for diagnosis.

## Expected result

The command prints five `PASS` groups, then `CLI-only agent conformance completed.` Evidence is written to `state/matrix-lab/cli-work-check/verification.json`.

It verifies:

1. A request is not claimable until approved; one worker owns it; progress and an idempotent result return to the sender.
2. Follow-up tasks and missing-input replies continue in the same conversation, including reverse-direction requests.
3. A connector restart preserves claim ownership and execution state.
4. Cancellation reaches a running worker and requires acknowledgement.
5. Offline delivery and an explicit failure return through the same adapter.

A successful scripted check verifies communication behavior, not automatic launch of a real model or restoration of arbitrary model memory. The [Agent guide](agent-connect.en.md) explains how an already running agent uses the same commands.

## Inspect, stop and reuse

```sh
docker compose -f deploy/matrix/compose.lab.yaml ps
docker compose -f deploy/matrix/compose.lab.yaml logs --tail 100 synapse-a synapse-b
docker compose -f deploy/matrix/compose.lab.yaml stop
```

Stopping preserves accounts, signing keys, stores and evidence. To run again, start the four server/database services with `up -d --wait` and repeat the check command. Do not delete the state just to retry a failed check. If a check failed before logout, its test profiles remain in the private lab state for inspection.

The lab is not an independently deployed public federation or load test. Homeserver ports are not published to the host; the broader lab's optional gateway mappings are loopback-only. For operating a real domain, use the [server deployment guide](matrix.md#部署独立域).
