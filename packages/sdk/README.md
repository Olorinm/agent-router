# Agent Router SDK

Use Agent Router directly from a JavaScript or TypeScript product. No CLI subprocess, Matrix password, or local CLI profile is required. The package uses Fetch and works in Node 22+ and modern web runtimes. For desktop products, keep credentials in the trusted host process rather than rendering them into the UI.

## Install

This initial version is not yet published to npm. After publication, the registry command will be:

```sh
npm install @agent-router/sdk
```

Before a registry release, build and pack this package and install the resulting `.tgz`. The package contains its compiled JavaScript and TypeScript declarations, and has no runtime dependencies. Do not import server files or rely on a checkout's absolute path.

```sh
npm run build --prefix packages/sdk
npm pack ./packages/sdk
# In the consuming product:
npm install /path/to/agent-router-sdk-0.1.2.tgz
```

## Sign in with an existing product account

A node operator can configure trusted HTTP identity providers. On `exchange`, Agent Router calls the provider's **existing authenticated user-info endpoint**, verifies the configured eligibility roles, and creates or finds an ordinary communication account. Products do not need to implement a new authentication endpoint. The node supports Matrix owner tokens and scoped Agent instance tokens separately.

```ts
import { AgentRouterClient } from '@agent-router/sdk';

const bootstrap = new AgentRouterClient({
  baseUrl: 'https://agents.example/_agent-router/v1',
  accessToken: '',
});
const session = await bootstrap.exchange({
  provider: 'my-product',
  accessToken: currentProductAccessToken,
});
// session: { serviceUrl, accessToken, expiresAt, owner, agent }
// owner is a Matrix user ID; expiresAt is a UTC ISO timestamp.
const router = new AgentRouterClient({
  baseUrl: session.serviceUrl,
  accessToken: () => getCurrentNetworkSession().accessToken,
});
```

The provider token is sent only to the selected trusted node and its configured user-info endpoint, never to a recipient's domain. Only choose nodes trusted to receive that product token. The node does not store provider tokens or copy email/display-name fields into usernames. Communication accounts use opaque identifiers. The returned `agent` is the account's default `client` sender; using it does not start a worker or grant anyone execution permission.

A network session lasts **10 minutes**. Before expiry, repeat `exchange` with a current product login token; it returns the same owner and sender with a new network token. A provider role removal prevents subsequent exchange; existing network credentials remain valid until expiry or explicit revocation. Keep network tokens in memory, discard them on product logout/account switching, and call `revokeSession()` when possible. Never silently adopt a new sender for an existing conversation. The callback is read for every authenticated request; it must return credentials belonging to the same captured product account. The SDK does not persist or refresh product login tokens.

Configure the node with your identity provider's URL, subject field, role field, and eligibility rules. The bundled [CONFIGURATION.md](./CONFIGURATION.md) contains a generic deployment example; no server source checkout is needed.

## Add a contact and send

```ts
import { taskText, taskStatusText } from '@agent-router/sdk';

const remote = await router.resolve('alice/researcher@agents.example');
// Save remote.address + the selected session.owner / session.agent.id in your
// application's own contact record. resolve validates the address; it does not
// grant remote receiving/execution permissions.
const task = await router.send({
  agentId: session.agent.id,
  address: remote.address,
  resolvedTarget: remote,
  text: 'Please review this idea.',
  messageId: crypto.randomUUID(), // persist this ID before sending
});
for await (const update of router.watch({
  agentId: session.agent.id,
  address: remote.address,
  resolvedTarget: remote,
  taskId: task.id,
  signal: abortController.signal,
})) {
  renderReply(taskText(update));
  renderExecutionStatus(update.status.state, taskStatusText(update));
}
```

`watch` polls durable tasks; it is not token streaming. It stops on completion, failure, cancellation, rejection, input-required or auth-required. Connection progress belongs in your execution-status area, not in reply text. `taskText` returns artifact text or the latest Agent history message; an input/auth-required status message is also treated as a question for the user. Other status messages, including progress and completion labels, are available separately through `taskStatusText`. Neither helper generates placeholders.

For subsequent messages, pass the returned `contextId` to `send`. To answer `TASK_STATE_INPUT_REQUIRED`, also pass the pending `taskId`. To resume after a crash or reconnect, use `get`/`watch` with the persisted task ID. Retry an uncertain send only with its original `messageId` and identical input; there are no implicit send retries. A send may time out locally while the remote task continues.

```ts
await router.send({ agentId: session.agent.id, address: remote.address,
  text: 'Continue the same conversation.', messageId: crypto.randomUUID(),
  contextId: task.contextId });
await router.cancel({ agentId: session.agent.id, address: remote.address,
  taskId: task.id });
```

Aborting a local HTTP request or `watch` only stops waiting. `cancel` explicitly requests remote cancellation. The task ledger cannot guarantee that an external side effect has stopped.

## Reuse a resolved recipient

Persist `{address, matrixId}` from `resolve` alongside the account-bound contact.
Pass it as `resolvedTarget` to `send`, `get`, `cancel`, or `watch`. Those calls
then use only your home gateway and do not depend on the recipient directory
being available. This also works after restarting the application. The SDK
checks that its address and Matrix server match the requested recipient; the
handle grants no authentication or execution permission. Without it, each
operation resolves the address again. Resolve again explicitly when the user
chooses to replace a contact; never silently change the recipient of a pending task.

```ts
const resolvedTarget = { address: remote.address, matrixId: remote.matrixId };
await router.get({ agentId: session.agent.id, address: remote.address,
  resolvedTarget, taskId: savedTaskId });
```

## Other account operations

- `agents(options?)`: list owned Agents.
- `createAgent(name, options?)`: create or return a same-name Agent under the owner.
- `resolve(address, options?)`: read a domain's public directory without sending credentials.
- `get({agentId,address,taskId,signal?})`: read a task.
- `revokeSession(options?)`: revoke an exchanged `ars_` session.
- `isTaskSettled(task)`: check whether polling should stop.

All HTTP credentials stay on the configured service origin; recipient directory requests are unauthenticated. Redirects are rejected. `fetch` can be supplied for a product's outbound network policy. Default request timeout is 30 seconds (`timeoutMs`); optional `allowLocalHTTP` permits only loopback HTTP for local integration tests.

## Errors

`AgentRouterError` exposes `code` and HTTP `status`; raw server error bodies are not echoed into messages. Abort and timeout errors retain the standard Fetch/AbortSignal behavior.

| Condition | Status / code | Product behavior |
| --- | --- | --- |
| Product login rejected | 401 / `external_session_invalid` | Refresh/re-authenticate with the product, then exchange |
| Eligibility role missing | 403 / `external_role_required` | Show access restriction; do not retry or provision another user |
| Provider/node not configured or unavailable | 503 | Show unavailable, preserving pending tasks |
| Network session expired/revoked | 401 / `account_session_invalid` | Exchange again for the same product account |
| Bad protocol payload | `invalid_response` | Surface a protocol error, not a fabricated answer |
| A2A error | `a2a_<numeric code>` | Handle task/protocol failure |

## Scope

This release covers product-side account bootstrap, Agent discovery/management, and durable messaging. It does not provide a UI, an identity provider, automatic worker deployment, or a model runtime. Existing CLI/runtime APIs remain available for workers. Matrix is the transport, A2A is the task protocol, and product identity is an optional node-level adapter.
