# Cloud Agents from the CLI

[English](cloud-environments.md) | [简体中文](cloud-environments.zh-CN.md)

A user logs into Router, selects an operator-provided environment profile and receives an Agent with its own cloud environment and automatically started Host. Chat platforms remain optional.

```sh
agent-router login @alice:agents.example
agent-router setup-options
agent-router setup helper --environment cloud-codex
agent-router channel-connect feishu   # Or another platform, whenever wanted
agent-router setup-check
```

`setup-options` lists the environment profiles available to this account, including their kernel. Profiles can use any runtime supported by Host; `cloud-codex` is only the example's name. `setup` waits for Host service/local runtime readiness. Native login/model access is established by a separate handshake or real task, not inferred from HTTP health.

## Continue or stop an environment

```sh
agent-router environment-status
agent-router environment-create cloud-codex --no-wait
agent-router environment-pause
agent-router environment-resume
agent-router environment-reconcile
agent-router environment-destroy
```

Commands act on the selected Agent. `environment-create` is also useful after `agent-create` or `agent-use`. Repeating creation for the same Agent/profile returns its existing operation. A disconnected terminal does not cancel provisioning. `environment-status` shows its durable progress; `environment-reconcile` looks up the recorded ID or unique creation metadata and never buys a replacement. An ambiguous or absent match needs operator investigation.

Pause and destruction stop the Router worker first and refuse active or uncertain runs. Resolve those runs using the existing execution recovery flow. Pause/resume preserves the environment ID and conversation binding, subject to the template's actual persistent storage. A destroyed or expired environment is never replaced silently: explicitly create a new Agent to start fresh. Destruction does not erase Router's conversation history, and cloud snapshots retained by the provider need separate operator cleanup.

While an environment is ready, Router renews its lifetime every 30 seconds. `lifetimeSeconds` must be at least 600. If Router is unavailable longer than that lifetime, the configured cloud timeout policy applies. Volcengine currently requires explicit pause and supports only `kill` on expiry in this adapter; choose lifetime/storage accordingly. A lost renewal is visible as `needs_action`; reconcile/resume instead of silently replaying work.

## Operator setup

This integration requires the matching, currently unreleased Router, Host bootstrap entrypoint and Agent Environment application-endpoint API. [Agent Environment PR #1](https://github.com/Olorinm/agent-environment/pull/1) and [Host PR #25](https://github.com/Olorinm/agent-host/pull/25) must be reviewed as dependencies; installing the older published Host archive does not add `--ready-file`. No npm release is assumed.

1. Build and verify the separate Host and Environment archives. Install Environment into Router's trusted server environment (or use [the derived image recipe](../../examples/cloud-environments/Dockerfile.router)); it is not installed on users' laptops. `modulePath` points to the installed package's `dist/index.js`. If omitted, Node resolves `@olorinm/agent-environment` as an installed dependency.
2. Prepare an existing Alibaba/Volcengine sandbox endpoint and API key with a cloud template containing Node 24+, Agent Host, the selected native runtime and dependencies. Configure the template's entrypoint to run `agent-host serve --ready-file ...` as described in Host's cloud example. Verify its durable workspace/native state and application-port routing. This flow allocates sandboxes; it does not create VKE/ACS infrastructure.
3. Copy [the environment profile](../../examples/cloud-environments/environments.json) and [Host configuration](../../examples/cloud-environments/host-profile.json) into a private server directory. Supply Environment's `providers.json` with private sandbox service key files. These keys remain on Router, outside every Agent runtime.
4. Set each profile's allowed `owners`; an explicit `"*"` enables all registered accounts. Assign user-specific native credential files through `files`, or provision runtime authentication through the chosen image's supported mechanism. Every file/command/URL comes from trusted operator configuration; HTTP callers select only a profile ID. Do not put personal login state in a shared image. Keep profile definitions/configuration files immutable for existing bindings; changing profiles requires deliberate migration.
5. Initialize onboarding and restart the matching Router service:

```sh
node dist/onboarding/init.js --out /private/onboarding.json \
  --environments-file /private/environments.json
# Configure this on the Router process/container:
# AGENT_ROUTER_ONBOARDING_FILE=/private/onboarding.json
```

Preserve the whole Router state directory, including the provisioning SQLite journal, channel bindings and private per-Agent Host tokens. Run one active provisioning coordinator against that state; it holds a renewable lease. Keep private provider/profile files accessible to the Router service account. The existing fixed `hosts` profiles remain supported.

The Host image starts before configuration arrives and waits for `host.json`, its dedicated token and a final SHA-256 manifest. Router uploads the bundle, checks authenticated Host readiness and binds the existing channel/Host worker. Neither a user account credential nor a cloud account key is passed to Host. Agent execution and native sessions remain Host/kernel responsibilities. No scheduling or UI layer is introduced.

For a private application gateway, configure Environment's `serviceUrl` separately from envd's `sandboxUrl`. It must route `E2b-Sandbox-Id` / `E2b-Sandbox-Port` and preserve application `Authorization`. Only a returned traffic access token accompanies application requests; cloud API and envd credentials are never used as Host credentials. A plain Kubernetes service proxy that strips Authorization is unsuitable.

## Verification

The regression suite covers account isolation, duplicate requests, lost creation responses, bootstrap manifests, same-ID pause/resume, unknown execution guards and missing environments. An independent package check installs all three archives and runs the Go CLI, actual Host process, durable Router/Host restart and continued native session binding:

```sh
sh scripts/build-cli.sh
npm run verify:cloud -- --environment-archive /path/agent-environment.tgz \
  --host-archive /path/agent-host.tgz --host-fixture /path/agent-host/test/fixtures/codex-server.mjs
```

Cloud lifecycle and the native model protocol in that check are fixtures. The earlier Environment Volcengine live acceptance does not certify this new complete onboarding chain. Full cloud/image/model acceptance and production deployment are separate steps; no live user service is changed by these tests.
