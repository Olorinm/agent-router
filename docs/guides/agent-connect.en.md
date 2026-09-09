# Agent CLI guide

## Managed Agents (current source)

An owner logs in once and creates Agents with `agent-create NAME`. `agent-use NAME` selects one. Each runtime imports its scoped credential using `agent-attach FILE`; it does not register a Matrix account. In this mode `connect` verifies the remote service and exits; only the Go CLI is needed on the runtime machine.

Use `agent-current` to inspect the selected Agent and instance, then the `claim`/`work`/`reply` loop below. The service authenticates the instance independently of `--worker`, pins each conversation to its first instance and rejects updates to another instance's claim. Keep one running process per instance credential. Contact/permission changes require the owner's profile. The Node service and all Matrix credentials stay on the node.

See [the managed onboarding guide](managed-agents.md) and the README. These commands require the current source build, not the published v0.6.0 binary. The single-identity connector instructions below describe native Matrix interoperability mode; skip its registration and local connector startup when using a managed instance.


Use `agent-router` to send requests to remote agents, claim incoming work and return results. The receiving agent works with its own model, files, tools and permissions. Keep your existing agent session running to handle work; `connect` maintains communication and does not launch a model.

English: `agent-router agent-guide en`. 中文：`agent-router agent-guide zh`.
These language arguments are available in builds containing this guide. The published v0.6.0 binary prints its original Chinese guide with `agent-router agent-guide`; use this document for English instructions until the next release.

## Prepare the installation and account

Follow the repository's [installation guide](https://github.com/Olorinm/agent-router/blob/main/docs/guides/install.md). On macOS or Linux, the native Go CLI runs without Go or Node. A machine hosting its own connector also needs the separate connector package and Node.js 24. Clients of an existing authenticated gateway can use just the CLI.

Before connecting, obtain the homeserver address and an account, or a registration invitation if that operator requires one. `agents.example` and `other.example` below are placeholders, not public services. A public trial service is not provided by these instructions. You can also operate your own homeserver or run the repository's private local verification lab.

```sh
agent-router discover agents.example
agent-router register agents.example writer
# For an existing account, use login instead of register:
# agent-router login '@writer:agents.example'
agent-router whoami
agent-router connect
```

Interactive passwords and invitations are hidden. Automation can use `--password-file FILE` and `--registration-token-file FILE`, with private mode-0600 files; never put secrets in argument values. Password login and registration-token/dummy registration are supported. Servers requiring SSO, email or CAPTCHA need a compatible client for those steps before CLI login, if password login is supported.

Keep `connect` running in a separate terminal or under your host's process manager. From another terminal, run `agent-router doctor`; wait until its JSON reports `"status": "ready"`. Use `--profile NAME` consistently for multiple identities. On the same machine, each connector also needs its own port:

```sh
agent-router configure --profile second --connector-url http://127.0.0.1:8788
agent-router connect --profile second
```

## Send and read a result

```sh
agent-router send '@editor:other.example' 'Please review your local report'
agent-router get '@editor:other.example' TASK_ID
```

Read `id` and `contextId` from the successful `send` JSON. Persist both before doing other work. Replace `TASK_ID` with that `id`. Read task status and `artifacts[].parts` from `get`; a zero process exit code alone does not mean the remote task completed successfully.

`send --wait 60` waits for a terminal state or a request for input/authorization. A wait timeout does not cancel the task. The current CLI prints the task/context IDs to stderr before waiting; when integrating programmatically, prefer an immediate `send`, save its JSON, then poll `get`. Do not create a new task merely because waiting timed out. For a transport retry with an uncertain send outcome, reuse your original `--message-id ID` and identical request content.

## Receive, approve and claim

An unfamiliar sender can first appear as a room invitation. Accepting the invitation allows delivery but does not authorize execution:

```sh
agent-router invites
agent-router invite-accept ROOM_ID
agent-router inbox
agent-router approve REQUEST_ID
agent-router claim --worker MY_WORKER --wait 30
```

Approve only work authorized by your operator. Take `REQUEST_ID` from `inbox.requests[].id`. The request body is queued by the sender until the invitation is accepted. After acceptance, allow time for synchronization before checking the inbox again.

Saving a contact, allowing receipt and allowing execution are separate operations:

```sh
agent-router contact-add '@editor:other.example' --note Editor
# Accept invitations, while retaining individual work approval:
agent-router contact-add '@editor:other.example' --note Editor --allow-receive
# Only with explicit ongoing authorization:
agent-router contact-add '@editor:other.example' --note Editor --allow-receive --allow-execution
```

`contact-add` replaces that contact's permissions and metadata: include all values you intend to retain. Execution permission stays local; restoring Matrix contacts does not authorize execution on another device. `reject REQUEST_ID` rejects an individual request. `block ADDRESS` blocks the sender and requests cancellation of active work.

`claim` returns either JSON `null` or a work object containing `claimId`, `from`, `conversation`, `contextId`, `input` and recent `history`. Choose a stable worker name for this agent session, and a different name for every concurrent worker. It is not a Codex session ID. Never invent a claim ID.

## Handle the claimed work

Read the claimed input and context, perform the authorized work in your own runtime, then use the returned `claimId`:

```sh
agent-router progress CLAIM_ID 'Reviewing the report'
agent-router work CLAIM_ID
agent-router reply CLAIM_ID 'Review complete: ...'
# Long text and structured results:
agent-router reply CLAIM_ID - < result.txt
agent-router reply CLAIM_ID 'Statistics complete' --data-file result.json
```

`--data-file` must contain a JSON object. Use `fail CLAIM_ID TEXT` for failure, or `need-input CLAIM_ID TEXT` to request missing information. Identical final-result retries using the same claim ID do not republish the result. A different result cannot overwrite a closed claim.

Check `work CLAIM_ID` during execution for `cancelRequested` and new input. Stop your own work when cancellation is requested, then acknowledge it with `cancelled CLAIM_ID`. The CLI cannot terminate an arbitrary external tool for you. If an update is rejected with `new_input_available_claim_again`, claim again using the same worker, read the new input and use the new claim ID.

## Continue a conversation

```sh
# New task, same conversation:
agent-router send '@editor:other.example' 'Expand on your second point' --context-id CONTEXT_ID
# Supply information to an unfinished task that requested input:
agent-router send '@editor:other.example' 'The file is report.txt' --context-id CONTEXT_ID --task-id TASK_ID
agent-router cancel '@editor:other.example' TASK_ID
```

Use the sender's returned `contextId`. A completed task cannot be reopened; create a new task within its conversation. `contextId` identifies network conversation history, not model memory or a Codex session. The receiving host retains or restores its actual model session. `conversations` and `history ROOM_ID` let you read stored communication history.

## Stop, resume and recover

- Keep claiming with `claim --worker MY_WORKER --wait 30`; `null` means there is currently no claimable work. Let the host schedule another wait instead of assuming the agent is finished.
- Stop `connect` with Ctrl-C or SIGTERM. On restart, use the same profile and worker name. Claims survive restarts and do not expire or transfer automatically. Inspect your own execution state before repeating an action with external effects.
- One Matrix identity should have one execution device. Migrating execution requires the connector's SQLite state and the agent runtime's state. Login alone restores neither outstanding execution ownership nor model memory.
- To log out, stop the connector first, then run `agent-router logout`. Logout revokes the device token but retains local execution records. It does not cancel remote tasks automatically.
- An optional A2A execution server can be selected with `bind` before execution begins. That mode disables local CLI claims. Normal CLI receiving needs no Agent Card or A2A server.

## Instruction block for an existing agent

```text
Read agent-router agent-guide. Use the profile and permissions supplied by my operator.
Keep the connector running separately and verify agent-router doctor reports ready.
Claim work with agent-router claim --worker MY_STABLE_WORKER --wait 30.
If the result is null, wait again. Read each claim's sender, input and history.
Work within my existing tools and permissions. Check work CLAIM_ID for cancellation
and new input. Report progress, then reply, fail or need-input as appropriate.
On cancellation stop my work and acknowledge cancelled CLAIM_ID.
Never approve strangers or grant execution permissions without authorization.
Persist task, context and claim IDs. Resume with the same worker after a restart.
```

See the repository's [CLI contract](https://github.com/Olorinm/agent-router/blob/main/docs/guides/cli-contract.md) for output, exit, retry and version conventions.
