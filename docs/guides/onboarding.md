# Open an account, connect an Agent, and start talking

[简体中文](onboarding.zh-CN.md)

The browser entry point is **`https://YOUR_ROUTER_DOMAIN/_agent-router/setup`**.
It reuses the node's Matrix accounts and existing Agent Host interfaces.
It is available when the operator enables `AGENT_ROUTER_ONBOARDING_FILE`.
Build from the current source; the published v0.6.0 release does not include this page.

## For users

1. Open the entry point on an existing service. Sign in, or register if the
   administrator enables registration. A registration token may be required.
   Existing products can take you here through their own login.
2. Create your Agent, such as `helper`, and select an execution service assigned
   to your account. The administrator installs and configures the actual runtime.
3. Optionally connect the platforms you use. You can choose several or skip
   them and use browser chat, CLI, or the SDK.
4. Check the connections, then send a message and confirm that it receives a reply.

| Platform | What you do |
| --- | --- |
| Feishu / Lark | Scan the official app creation QR. If personal services are selected, complete a separate consent step for your calendar, documents, etc. Select a Host first for personal tools. |
| Weixin | Scan Tencent's iLink QR and confirm. Enter the pairing code shown on your phone if prompted. Private chats only. |
| Telegram | Create a bot with BotFather, provide its token, then open the dedicated link and press Start. The service binds the user who completes that exact private-chat proof. |
| Email | Choose an administrator-configured Grove Mail service, provide the inbox address/API key and your sender address. This is not Gmail/Outlook OAuth. Existing AgentMail integration remains available through its existing configuration. |
| Matrix | Enable the connection, then message the Agent using your existing Matrix account. |

The service saves connections privately and applies them without restarting the
Matrix connector. App secrets, channel tokens and Host tokens stay on the server.
The page does not store account tokens in localStorage.
Web chat supports text tasks, actual replies, continuation, stopping, and recovering
recent tasks after a page reload. Browser conversations use the account's `client`
Agent; they have their own A2A contexts. The linked private-channel main session
continues to follow the existing [channel rules](personal-channels.md).
An owner's browser caller can use their linked personal tools; an authorized
friend does not receive those personal tools.
The owner page also displays the Host's pending questions and permission choices.
Answers reuse the runtime's native response format. Passwords and other sensitive
prompts must be completed through the Host's native interaction entry point.

### Use a friend's Agent

You do not need your own Host to call a friend's Agent.

1. Sign in on the same service. Copy the **caller address** shown in the chat section,
   for example `bob/client@agents.example`.
2. Send that address to the Agent owner. They choose their Agent and save your
   address under **Let a friend use your Agent**.
3. Open their Agent address, such as `alice/helper@agents.example`, in your chat section.

**Allow** permits requests from that caller; **Ask** leaves incoming requests for
the owner to approve or reject on the page; **Deny** blocks them.
These settings authorize use of the Agent; they do not transfer ownership or
allow changing its connections, execution configuration, or account.
The browser's friend lookup currently covers this service. CLI/SDK federation
continues to use the existing cross-domain route.

## For service operators

Prepare the existing [managed node](managed-agents.md) once: Matrix accounts,
the Application Service registration, Router state, and HTTPS routing. Run
Agent Host separately and configure an actual runtime with a workspace and
model credentials. Use a Host version with the public HTTP v1 health, runtime
inspection and run interfaces.

Build the Router, then generate a private onboarding configuration:

```sh
npm ci
npm run build
npm run onboarding:init -- \
  --out /private/router/onboarding.json \
  --owner '@alice:agents.example' \
  --host-url http://agent-host:8787 \
  --host-token-file /private/router/host-token \
  --runtime personal
```

Keep the existing `MATRIX_*` and `AGENT_SERVICE_URL` settings and enable:

```sh
AGENT_ROUTER_ONBOARDING_FILE=/private/router/onboarding.json npm run agent:service
```

The Host URL must be reachable from the Router process/container.
Use HTTPS or a trusted private network for token-authenticated service traffic.
For the root Compose example, place the configuration and static Host token in
`state/agent-service-secrets/`, set
`AGENT_ROUTER_ONBOARDING_FILE=/secrets/onboarding.json`, and use token paths
that resolve inside that container. Rebuild and restart `agent-service` once.
Dynamic channel credentials and consent refresh data live under the writable
`/state/onboarding/` volume. Back up that volume together with the Router's
registry and per-Agent journals. Caddy already routes `/_agent-router/*`.

You can also run `onboarding:init --out FILE` without Host options. This enables
login and shared-Agent use without assigning every new user an execution service.
The initializer refuses to overwrite an existing configuration.

Configuration shape (examples are placeholders):

```json
{
  "registration": false,
  "hosts": [{
    "id": "alice-host",
    "label": "Alice's execution service",
    "owners": ["@alice:agents.example"],
    "url": "http://agent-host:8787",
    "tokenFile": "host-token",
    "runtimeId": "personal"
  }],
  "mailServices": [{
    "id": "mail",
    "label": "Grove Mail",
    "url": "https://mail.example",
    "attachmentOrigins": []
  }],
  "targets": ["alice/helper@agents.example"]
}
```

Paths in this file resolve relative to it. Host profiles must name their eligible
account owners explicitly; the browser cannot submit arbitrary service URLs,
token-file paths, executable commands or workspaces. New registrations do not
automatically receive a Host.

`registration: true` (or initializer `--registration`) only shows the registration
flow. Enable the desired registration policy on the Matrix homeserver as well.
The page supports Matrix password login and dummy/registration-token UIA.
Other Matrix SSO/CAPTCHA/terms flows require a compatible external client or
the product login integration below.

**Router account isolation is not an execution sandbox.** Agent Host runs with
its configured filesystem, tools and credentials. For accounts that should
not trust each other's code, use separate Host containers/OS boundaries and
private workspaces. Granting a friend execution access should use a runtime
whose capabilities you intend to share.

### Existing product login

Keep the [existing identity bridge](product-integration.md). After your product
exchanges its eligible login for a Router session, use the SDK:

```ts
const link = await router.onboardingLink();
// Navigate the user's browser to link.url.
```

The user sees the account identity and continues into the page. The link contains
a one-use, 60-second ticket in its fragment, never the account token. Redemption
sets an HttpOnly, SameSite browser cookie. Subsequent requests still validate
the underlying account/session, including bridge expiration and revocation.
An external session's existing short lifetime is not extended by this page;
the product should obtain a new link when login is required again.
`productLoginUrl` in the operator configuration can point back to the product's
login page. Products retain responsibility for login/refresh and eligible roles.

## Recovery and verification

- Existing `AGENT_ROUTER_CHANNELS_FILE` definitions are used until an Agent saves
  an onboarding override. Saving keeps its existing configured connections.
- Before the first native turn, you can select another Host. Once native bindings
  exist, changing the runtime/Host/personal tool set requires a new Agent or
  deliberate operator migration. Active or unknown runs prevent reconfiguration.
  Reauthorization of an existing personal account does not replace its tools.
- Browser sessions and pending QR jobs are in memory. A Router restart requires
  sign-in again; saved connections, account identities, tasks and native bindings
  remain on disk. Feishu personal consent state is saved privately and can resume.
- If Feishu app creation was interrupted after receiving a QR, inspect the
  existing app first. Recover the original app and owner's credentials into that
  Agent's private Feishu directory using the [official setup flow](personal-channels.md);
  remove `creation-pending.json` only after confirming no app was created, then retry.
  The service does not silently create another app after an unknown outcome.
- Connection checks do not consume provider updates, send test messages or call
  models. A real account/channel/model round trip must still be confirmed.

Development: `npm test` covers login/UIA, account isolation, handoff tickets,
configuration persistence/rollback, owner/friend permissions, actual Router/Host
fixture replies, and provider QR/pairing protocols. After building,
`node scripts/preview-onboarding.mjs` opens a local fixture service for browser
review (account `alice`, password `preview`); it disables external platform setup
and never calls a model.
