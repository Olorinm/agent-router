# Changelog

Notable changes to Agent Router, newest first. Pushing a `v*` tag publishes a GitHub Release whose
notes are this file's section for that version (`.github/workflows/release.yml`), so add the section
in the version-bump commit before tagging.

## [Unreleased]

- Removed the legacy operator channel path: `ChannelRouter` with its allow/ask/deny visitor approvals,
  the AgentMail adapter, `AGENT_CHANNELS_CONFIG_FILE` (`config.channelConfigFile`), the
  `/agents/:agentId/channels*` routes and `createRouter().channelIds`. On first start Router deletes
  the stored entries, visitors and events; they are not migrated. Agent deletion no longer checks for
  channel entries. Mail goes through per-agent Grove Mail connections.
- Channel-agnostic core. Each adapter lives in `src/channels/<kind>/` and exports a module (config
  schema, factory, access check). Router builds adapters through `src/channels/registry.ts`, and
  adapters use only the public `src/channels/api.ts`; a test enforces these import boundaries. The
  connection configuration format, channel behavior and the `ServiceHttp`/`ChannelHttpError` exports
  are unchanged. See `docs/guides/adding-a-channel.md`.
- Removed the Feishu personal (user-identity) tools. Router no longer runs the official Lark CLI,
  contributes a Feishu product tool to Host runs, or polls personal authorization. Removed: the
  `GET/POST /agents/:agentId/communication/connections/:connectionId/authorization[/:action]` routes,
  `ServiceExtension.authorization`, the `feishu_personal` check entry, the `personalTools` option of
  `POST /agents/:agentId/connections` (now rejected) and of failed-job `recovery`, the Go CLI
  `channel-auth` command and `--messaging-only` flag, `npm run feishu:setup` personal authorization
  (`--domains`, `--no-wait`, `--complete`), and the `@larksuite/cli` dependency. The channel API drops
  `ChannelInstance.authorization`/`tools`, `ChannelAuthorization`, `ChannelTool` and
  `ChannelCheckResult.extra`. Feishu messaging is unchanged; `credentials.json` and `app-secret` are
  still written to the Agent's Feishu directory, so a separate connector can reuse the app.
  `personalTools` in `channels.json` is still accepted and ignored.
- **Upgrade: the Host scope changes for every Agent with a Host.** The tool instructions no longer
  describe the Feishu tool, and Agents that had `personalTools: true` lose that tool definition.
  `communication_host.scope` is not migrated, so a store with runs makes Router fail to start with
  `host_binding_configuration_changed`. Before starting this version, with Router stopped and no
  `running` or `unknown` run, delete the stored scope of each such Agent
  (`DELETE FROM documents WHERE collection='communication_host' AND id='scope'` in
  `agents/<agentId>.sqlite`). Router writes the new scope at start; execution sessions are kept.

## [0.7.0-alpha.11] - 2026-11-06

- Owner ledger, phases 3–7 of ADR 0005. Every feature has its own flag and is off by default.
  - Send through Router (`AGENT_LEDGER_SEND`): a web channel, `POST /web/chats/:chatId/messages` with
    an idempotency key, owner DMs merged across channels, and redaction of own web messages.
  - Cards and control (`AGENT_LEDGER_CARDS`, `AGENT_LEDGER_CONTROL`): one card record for every
    answer surface, a retry card for unknown outcomes, cancel, steer, reset and chat purge.
  - Attachments (`AGENT_LEDGER_ATTACHMENTS`): local or R2 blob store, proxied downloads, per-owner
    quota, files to and from the agent.
  - Native groups (`AGENT_LEDGER_GROUPS`): rooms, members, mentions and capped group context. Only
    the owner's `@agent` or `@all` reaches agents.
  - Identity (`AGENT_LEDGER_IDENTITY`): persons, linked channel identities and `/link` pairing codes.
- Edge login: `AGENT_EDGE_IDENTITY_FILE` verifies Cloudflare Access JWTs, with an Origin check on
  unsafe requests.
- Matrix is optional: `AGENT_MATRIX=off` runs without a homeserver, agents have an `active`,
  `dormant` or `none` Matrix state, and `ledger:promote-media`, `matrix:export` and `matrix:forget`
  prepare a homeserver for removal. Both CLIs gain an edge login.

PRs: [#74](https://github.com/Olorinm/agent-router/pull/74), [#75](https://github.com/Olorinm/agent-router/pull/75), [#76](https://github.com/Olorinm/agent-router/pull/76), [#77](https://github.com/Olorinm/agent-router/pull/77), [#78](https://github.com/Olorinm/agent-router/pull/78), [#79](https://github.com/Olorinm/agent-router/pull/79), [#80](https://github.com/Olorinm/agent-router/pull/80), [#82](https://github.com/Olorinm/agent-router/pull/82)

## [0.7.0-alpha.10] - 2026-11-05

- Owner ledger, phases 1–2 of ADR 0005. The API is read-only and behind a flag; sending still goes
  through Matrix.
  - Shadow ledger. The channel core writes every channel's traffic to
    `ledger_*`, `hub_*` and `reg_*` tables: ingress, conversations and sessions, events with a
    sequence that has no gaps, turns, cards, deliveries and the platform-message index. Every
    ledger write runs in a SQLite savepoint, so a ledger failure never changes the current
    behavior; failures are reported at `/debug/ledger`.
  - Backfill with `npm run ledger:backfill -- (--agent <id>|--all) [--dry-run] [--synapse]`. It
    runs offline and can be repeated safely.
  - Read-only owner history when `AGENT_LEDGER_READ=1`: `/web/me`, `/web/chats`, chat events
    (page, delta or reset), read markers and turns. A WebSocket at `/web/socket` (opened with
    `POST /web/socket-tickets`) replays events from a position and streams live updates.
    Embedders must attach `router.upgrade` to their server's `upgrade` event. Adds the `ws`
    dependency.
- CLI: `agent-delete NAME|ID --yes` deletes an owned Agent. It clears the profile's current
  selection if that Agent was selected.
- `SECURITY.md` explains the public Agent directory: why it needs no authentication, what it
  reveals, its per-IP rate limit, and that a private node should sit behind an access gate.

PRs: [#72](https://github.com/Olorinm/agent-router/pull/72), [#73](https://github.com/Olorinm/agent-router/pull/73)

## [0.7.0-alpha.9] - 2026-11-05

- Delete Agents with `DELETE /_agent-router/v1/agents/:agentId` (owner only) or
  `ManagedService.delete(owner, id)`. Embedders can hook `beforeDelete` (product teardown;
  a failure leaves the Agent untouched), `afterDelete` (purge product state) and `deprovision`.
- Deletion deactivates the Agent's Matrix account and removes its registry entries, instances
  (their tokens stop working), its database and its channel credentials. Messages already sent stay
  in room history. An interrupted deletion leaves the Agent `deleting`; repeating it finishes.
- Deletion is refused while the Agent has an active or unknown run, is used by a channel
  configuration, or has a connection setup running.

PR: [#71](https://github.com/Olorinm/agent-router/pull/71)

## [0.7.0-alpha.8] - 2026-11-05

- Run archives keep whole native items, following Agent Host's durable history. The budget grows
  from 512 KB to 2 MB. A long value keeps its first 48k and last 12k characters, with a marker
  saying how many were omitted.
- Inline media (`data:` URLs from pasted images and screenshots) is replaced with
  `data:<mime>;omitted` and does not count as truncation.
- Event pages report the two cases separately: `historyTruncated` means events were really lost,
  and the new `contentTruncated` means some values were shortened. Older archives are classified by
  their clip marker.
- Accepts Host `liveGap`. It does not mark an archive as truncated, and the streaming observer stops
  stitching `assistant.delta` text across the gap.
- CLI build defaults are set to this version.

PRs: [#68](https://github.com/Olorinm/agent-router/pull/68), [#70](https://github.com/Olorinm/agent-router/pull/70)

## [0.7.0-alpha.7] - 2026-10-30

- Native work sessions. A public `WorkSessions` lists owner sessions, native history, internal
  deliveries and dependency waits. Run requests carry a `HostAdmission` written by the product,
  never inferred from model text or tool names. Native Host errors keep their payload.
- Matrix group mentions.
  - An owner's group message starts work only if it @-mentions this Agent or everyone.
  - Groups that contain only the owner and the owner's Agents get owner grants; mixed groups do
    not.
  - `ai.mau.room {kind:"group"}` keeps groups with a single Agent as groups.
- Finished runs are copied into run archives and read from there, so their history stays readable
  while the Host sleeps.

PR: [#64](https://github.com/Olorinm/agent-router/pull/64)

## [0.7.0-alpha.6] - 2026-10-21

- Replacing a Host binding keeps the channel identity and safely resets the execution state.
- Run observation scoped to the owner, isolation between conversations, and package builds that
  can be reproduced.

## [0.7.0-alpha.5] - 2026-10-16

- Observation receipts include delivered task status notices. Consumers can render one execution
  view without duplicate cancellation acknowledgements.

## [0.7.0-alpha.4] - 2026-10-16

- The public Router API exposes, scoped to the owner:
  - task origins, run snapshots and calls;
  - Host event reads by cursor;
  - interaction results;
  - durable cancellation.

  Host event payloads, IDs and decisions are passed through unchanged.
- Channel reply IDs are recorded so clients can deduplicate generated updates.
- Agent ownership and Host run/session identity are checked before execution data is exposed.

## [0.7.0-alpha.3] - 2026-10-14

- `agent-router channel-connect feishu --app-id cli_…` recovers an existing Feishu app through
  official consent.
- Setup history survives restarts, with recovery instructions after an expired or interrupted
  registration. Credentials are saved before binding and reused if binding fails.
- Bot messaging no longer waits for personal-tool authorization, and checks report the two
  separately. Apps already assigned elsewhere, and authorization results that don't match, are
  rejected.

## [0.7.0-alpha.2] - 2026-10-14

- Channel registration and polling move into the public lifecycle. Embedded Routers (`createRouter`)
  also poll operator-managed channels. Start and close are idempotent.
- Optional Host-binding wake hook, called only when authorized, deliverable work is waiting. The
  product owns the sleep and resume policy.

PR: [#53](https://github.com/Olorinm/agent-router/pull/53)

## [0.7.0-alpha.1] - 2026-10-14

- Managed Agent accounts, with Agents created per owner and worker instances scoped separately. A
  standalone product SDK uses the official A2A JSON-RPC transport for send, get, cancel and watch
  (#24, #26, #28).
- Personal channels: Feishu (with the official app and personal authorization), Telegram, Weixin
  and Matrix conversations. Each turn's result is sent back to the original chat (#38).
- Channel media, streaming and native conversation controls: questions, follow-up input and cancel
  (#44).
- CLI `setup`, Host selection, channel connection jobs with terminal QR codes, renewal of personal
  authorization and connection checks (#45).
- Fixes for Feishu delayed messages, group mentions and native activity feedback (#47). Codex
  worker connection failures are reported (#22).
- The official larkCLI runs in the Agent's execution environment, and channel requests carry the
  provider IDs it needs (#48).
- Cloud Agent onboarding through environments, replacing the standalone Codex worker (#49, #50,
  #51).
- Provisioning and environment lifecycle moved out to Mau. Router exposes a public server
  composition API and opaque Host bindings, and the provisioning routes and CLI commands are
  removed without aliases (#52).
- English README by default, with a Chinese translation (#42, #43).

## [0.6.0] - 2026-09-08

- A standalone Go CLI for the Matrix-based Agent network. Agents use `agent-router` to send
  requests, receive and claim work, return results and continue conversations. Matrix and A2A sit
  behind that interface.
- Matrix/Synapse supplies accounts, rooms, stored messages, sync and federation. Contacts,
  directory lookup, blocking, history and read markers are available through the CLI.
- The full send/approve/claim/progress/reply workflow runs without a separate A2A execution server.
  Durable claims, cancellation, offline delivery, deduplication and restart recovery are supported.
- Homebrew: `brew install Olorinm/tap/agent-router`. The communication service is packaged
  separately as `agent-router-server` (`agent-router-connector`).
- **Breaking:** custom Router accounts, JWT federation, RabbitMQ transport and the old command
  semantics are removed. No migration is provided for data from older Router versions.

## [0.3.0] - 2026-09-03

- Shorter CLI onboarding: top-level `login`, `invite`, `join` and `find`. Invitations and
  credentials are entered at hidden prompts. By default `send` waits for the A2A result; `--detach`
  runs it in the background.

PR: [#14](https://github.com/Olorinm/agent-router/pull/14)

## [0.2.0] - 2026-09-03

- Standalone Go CLI built on the official A2A Go SDK, storing credentials in the OS credential
  store. It covers profiles, discovery, directory search, A2A send and task commands, and project
  linking (#8).
- Single-use scoped enrollment tokens, self-service Agent registration, and Agent credential
  list/create/revoke/rotate (#8).
- Agent Cards from the current JS SDK are normalized so Go clients accept them (#12). Release
  actions are updated (#13).

## [0.1.0] - 2026-09-03

- First public alpha.
  - Official A2A v1 support: REST, JSON-RPC, SSE, tasks, cancellation and push.
  - Authenticated agent registry scoped by domain.
  - PostgreSQL TaskStore with a transactional outbox.
  - Delivery dispatcher on RabbitMQ.
  - Experimental Federation Profile 1.0, deny by default.
