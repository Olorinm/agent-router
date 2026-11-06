# Adding a channel

A channel adapter connects one messaging provider to the channel core. The core owns everything that is
the same for every provider: durable receipt, deduplication, owner/peer/group admission, conversations,
turns, the outbox with retries, the ledger and identity. An adapter only translates provider messages into
`ChannelMessage` and sends replies.

## Layout and boundaries

```text
src/channels/api.ts          public adapter API: types, helpers, the ChannelModule contract
src/channels/registry.ts     kind → module; the only Router file that imports adapters
src/channels/<kind>/index.ts the module: config schema, factory, access check
src/channels/<kind>/…        the adapter and its provider code (vendor SDK wrappers, media, …)
```

`test/channel-boundaries.test.ts` enforces the rules that keep an adapter movable into its own package:

- An adapter imports Router code only from `src/channels/api.ts` (plus npm packages and files in its
  own directory). It never imports another adapter or the registry.
- Router code reaches adapters only through `src/channels/registry.ts`, and only the composition root
  (`src/service/`) uses the registry.
- The built-in surfaces `matrix`, `web` and `room` are tied to Router internals (the Matrix connector, the
  ledger) and ship with Router; they may import those internals but still not another adapter.

## Minimal adapter

`test/fixtures/echo-channel/index.ts` is a complete working example built on the public API only, and
`test/channel-module.test.ts` runs it through the core. The skeleton:

```ts
import { z } from "zod";
import { bindAccount, configFile, connectionFields, defineChannel, sendChunks, type ChannelAdapter,
  type ChannelContext, type ReplyRoute } from "../api.js";

class ExampleChannel implements ChannelAdapter {
  readonly kind = "example";
  /** True only if the provider deduplicates a resubmitted send key. */
  readonly retrySafe = false;
  readonly capabilities = { receive: ["text"], send: ["text"], stream: false, buttons: false, native: [] };
  private context!: ChannelContext;
  constructor(private readonly token: string) {}
  async start(context: ChannelContext) {
    this.context = context;
    bindAccount(context, "<stable provider account id>"); // a later different account needs a new connection id
    // Subscribe or start polling (see PollingChannel). For each provider message:
    // context.receive({ externalId, sender, threadId, scope: "direct" | "group", text, reply: { target, messageId, data: {} } });
  }
  async stop() { /* unsubscribe / abort polling */ }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    return sendChunks(this.context, sendKey, text, 4000, async (part) => "<provider message id>");
  }
}

export const exampleChannel = defineChannel({
  kind: "example",
  schema: z.object({ ...connectionFields, kind: z.literal("example"), tokenFile: configFile }).strict(),
  account: (config, { files }) => files.secret(config.tokenFile),
  create: (config, { files }) => {
    const make = () => new ExampleChannel(files.secret(config.tokenFile));
    return { adapter: make(), reload: make };
  },
});
```

Register it in `src/channels/registry.ts`: add the import, the module to `channelModules` and its schema to
`connectionSchema`. Nothing else in Router changes.

## Checklist

- [ ] `src/channels/<kind>/index.ts` exports a `defineChannel(...)` module; the directory name equals `kind`.
- [ ] Schema: `z.object({ ...connectionFields, kind: z.literal(kind), … }).strict()`. Credentials are file
      paths read through `files.secret`/`files.path`, never inline values.
- [ ] `account()` returns the provider account (bot, app, inbox) so the same account cannot be configured twice.
- [ ] `validate()` returns issue codes for cross-field rules (e.g. a provider without group chats).
- [ ] `start()` calls `bindAccount`, and `context.receive` returns only after durable receipt: advance a provider
      cursor only after it returns. Keep cursors and dedup state in `context.checkpoint`, not in memory.
- [ ] `externalId` is the provider's stable message id; a redelivery with the same id is deduplicated by the core.
- [ ] `scope`, `groupId` and, if the provider reports them, `mentions` are set, so group admission works.
- [ ] `retrySafe` is true only if the provider deduplicates a repeated send key; otherwise use `sendChunks`,
      which makes an interrupted send `uncertain` rather than resending it.
- [ ] Raise `ChannelSendError("retry" | "failed" | "uncertain", code)` from sends; `ChannelHttpError` with 401/403/410
      from `PollingChannel.poll` stops polling and reports the connection disconnected.
- [ ] Optional capabilities (`sendContent`, `readAttachment`, `progress`, `native`, `activity`) are declared in
      `capabilities` and implemented together.
- [ ] `check()` verifies access without consuming messages or sending anything (`npm run channels:check`).
- [ ] Tests for the adapter's mapping (provider fixture → `ChannelMessage`, reply → provider request).
- [ ] `npm run typecheck`, `npm test` (includes the boundary test) and a CHANGELOG entry.
