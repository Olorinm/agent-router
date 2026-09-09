# CLI integration contract

This document describes the current CLI behavior for agent hosts and scripts. The CLI delegates message/task operations to the Matrix/A2A connector; callers do not need an SDK or an A2A execution server to use the claim/reply workflow.

## Versions and compatibility

`agent-router --version` returns a JSON object containing `version` and `implementation` (`go`). `agent-router-connector --version` returns `version` and `component` (`connector`). Install matching release versions. Source builds may contain unreleased behavior; in particular, optional `agent-guide en|zh` selection is newer than v0.6.0.

Within a release line, integrations should tolerate additional JSON fields and field-order/whitespace changes. Changes to command names, required arguments, existing field meanings or retry behavior must be documented in release notes; new incompatible behavior belongs in a new release line. This project is pre-1.0 and does not promise compatibility with every previous minor version. Pin releases for unattended deployments and run your integration checks before upgrading.

## Processes and streams

| Command | stdout | stderr / lifetime |
| --- | --- | --- |
| `--version` | One JSON object | Short-lived |
| `--help`, `agent-guide` | Human-readable text/Markdown | Short-lived, no account required |
| Account, message, task and work operations | JSON value, or empty for operations with no response body | Errors/diagnostics; short-lived |
| `claim` with no available work | JSON `null` | Successful command, safe to wait again |
| `watch` | One compact JSON value per line | Long-running until stopped/disconnected |
| `connect` | Service logs; do not parse as a command response | Foreground communication process; keep it running |

Capture stdout and stderr separately. Parse JSON as a complete value, rather than by line, except for `watch`. Do not parse log prose as a stable machine interface.

Ordinary CLI commands exit **0** on success and **1** on an error. Signals and the connector process can have host-specific termination statuses. An exit code of 0 for `send` or `get` says that command succeeded; inspect the returned task's `status.state` to decide whether remote work completed, failed, was canceled or needs input. Errors are currently text on stderr, often beginning with a recognizable code; there is no universal JSON error envelope or distinct exit code per error category.

## Identifiers and results

| Value | How it is obtained | How it is used |
| --- | --- | --- |
| Task ID | `send.id` | `get ADDRESS TASK_ID`, `cancel`, or `--task-id` when supplying missing input |
| Context ID | `send.contextId` | `--context-id` for later requests in the same conversation |
| Pending request ID | `inbox.requests[].id` | `approve REQUEST_ID` or `reject REQUEST_ID` |
| Claim ID | `claim.claimId` | `work`, `progress`, `reply`, `need-input`, `fail`, `cancelled` |
| Room ID | Invitations/conversations or `claim.conversation` | Accept invitations, read history, set read markers or leave |
| Worker name | Chosen and persisted by the receiving host | `claim --worker NAME`; unique per concurrent worker |
| Message ID | Chosen and persisted by the sender for retryable sends | `send --message-id ID` with identical content and target/context/task options |

Treat returned IDs as opaque and persist the exact strings. A receiver-local work ID need not equal the sender's task ID. Model session IDs are managed by the host; network context IDs do not restore model sessions.

Task replies are in `artifacts[].parts`; parts may contain text or structured data. Claim input is in `input.parts`, with recent `history` also available. Do not assume every part is text. Task state names are the official A2A representation returned by the CLI, such as `TASK_STATE_COMPLETED` and `TASK_STATE_INPUT_REQUIRED`. Avoid assuming a fixed JSON field order or that optional arrays/fields are always present.

## Waiting and retrying

- `claim --wait N` accepts 0–60 seconds. It returns a claim or `null`; repeat with the same worker name. Claims have no automatic expiry or worker takeover.
- `send --wait N` accepts 0–600 seconds. It waits for a terminal task state, input-required or auth-required. It prints task/context IDs to stderr before polling. Timeout returns exit 1 with `wait_timed_out_task_remains_available`; stdout may be empty. It does not cancel the task.
- For integrations, prefer immediate `send` with a caller-generated message ID, save its JSON, then poll `get`. Do not lose the only task reference by assuming a timed-out wait returns JSON.
- If a send's outcome is uncertain, retry with the same message ID and identical content/target/options. Reusing that ID with different content is not a new request. Message/task identifiers and deduplication are scoped to the authenticated sender.
- Retry an uncertain final-result submission with the same claim ID and identical content. Changed content cannot replace a completed claim. CLI deduplication does not make arbitrary external side effects exactly-once.
- `need-input` keeps the task open. On new input, claim again with the same worker, read the updated input and use the fresh claim ID. `new_input_available_claim_again` means the old view is stale.
- Canceling a claimed task requests cancellation. The receiving host must stop its work and acknowledge with `cancelled CLAIM_ID`. The CLI does not terminate the host's model or tools.

## Configuration

Use `--profile NAME` consistently, or `MATRIX_PROFILE`; otherwise the profile is `default`. `MATRIX_CONFIG_DIR` changes the configuration root (normally `~/.config/agent-router/matrix`). Account directories are private 0700, session files 0600. Profiles contain device credentials; do not expose or copy them into reports.

Local profile mode supplies its own connector URL/token. Same-machine profiles need different ports configured with `configure --connector-url http://127.0.0.1:PORT`. One execution identity should have one execution device.

For an existing gateway, provide `CONNECTOR_URL` and `CONNECTOR_API_TOKEN_FILE`. Do not set `--profile` or `MATRIX_PROFILE`, which take precedence and select local profile mode. The gateway must belong to the intended agent identity. Use HTTPS when it is remote.

`connect` finds `agent-router-connector` on PATH. Source installations can use `--connector-runtime FILE` or `AGENT_ROUTER_CONNECTOR_ENTRY`; `AGENT_ROUTER_NODE` selects Node for that mode. The host owns connector lifecycle and model execution. Stop the connector before account-changing operations such as login or logout.

## Common recovery actions

| Diagnostic | Action |
| --- | --- |
| `not_logged_in` | Register/login using the intended profile |
| `connector_service_not_installed` | Install the matching connector and expose it on the host's PATH |
| `network_request_failed` | Check the connector process, URL, TLS and connectivity; preserve existing request IDs |
| `claim_requires_worker_name` | Supply the host's stable worker name |
| `wait_timed_out_task_remains_available` | Query the original task; do not submit another task |
| `new_input_available_claim_again` | Claim again with the same worker and use the fresh claim ID |
| `claim_closed` | Inspect current work/task state before attempting another update |

For supported command syntax run `agent-router --help`; for the receiving workflow read the [Agent guide](agent-connect.en.md). Public protocol details are in the [Matrix event profile](../spec/matrix-events-v1.md).

## Managed account and instance mode (current source)

`agent-create NAME` creates/selects an owned Agent; retries with the same owner/name return the existing Agent. `agent-use NAME`, `agents` and `agent-current` expose selection and ownership. `agent-instance-create NAME --out FILE` creates or rotates a scoped instance token into a new 0600 file; stdout omits the token. `agent-attach FILE` verifies that token and saves `agent.json` separately from the owner's `session.json`. `agent-instances` lists public instance status; `agent-instance-revoke ID` revokes access.

A selected profile with `agent.json` uses managed gateway mode. Explicit `CONNECTOR_API_TOKEN` or `CONNECTOR_API_TOKEN_FILE` selects the environment gateway when neither `--profile` nor `MATRIX_PROFILE` is set. An owner token is checked on its own Matrix origin and refreshed on expiry, including during a long wait. An instance needs no Matrix account profile. `connect` checks readiness and exits in managed mode. The service replaces the caller-supplied worker name with the authenticated instance ID, enforces claim ownership and pins each context to its first instance. Changing credentials for the same instance name preserves the instance ID. It does not migrate a harness's files or model session.

`owner/agent@server` addresses resolve through the exact-address HTTPS directory before the existing Matrix/A2A routing. Native MXIDs remain accepted. Registration creates human accounts; Agent creation does not prompt for passwords or invitations. Managed commands are not in the published v0.6.0 release.
