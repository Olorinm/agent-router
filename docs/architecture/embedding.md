# Embedding Agent Router

The server archive exports `@agent-router/server`. Products import that public
entry point, never `src/` or `dist/` implementation paths. The standalone Router
uses the same `createRouter` factory.

```ts
import { createRouter } from '@agent-router/server';
const router = createRouter(config, { connections: {} });
const server = router.app.listen(8790, '127.0.0.1');
await router.start();
// On shutdown: stop accepting requests, then await router.close().
```

`config` is the Router service configuration (Matrix service identity, public
Router URL and private state directory). `loadServiceConfig()` reads the normal
operator environment variables. `connections` accepts a JSON file path or an
object containing `mailServices`. Router does not load cloud providers or
initialize environments.

Trusted application code uses `router.service` for account authentication and
Agent identity, and `router.connections` for atomic connection/Host binding edits.
HTTP callers cannot supply arbitrary Host endpoints or local credential paths.

A Host configuration specifies a `runtimeId`, `instanceName`, `instructions`,
and either `url` + `tokenFile` or a product-owned opaque `binding`. For opaque
bindings the product must supply `hosts.assertReady`, `hosts.host` and `hosts.http`.
These resolve execution access without exposing environment IDs or providers to
Router. `HttpAgentHost` and `ServiceHttp` implement the public Host HTTP protocol.
Bindings are execution identities: they must not silently target a replacement
runtime or discard native sessions.

`connections.withStoppedRuntime(owner, agentId, operation, rollback)` serializes
runtime replacement, stops delivery workers and refuses active/unknown runs
before invoking a product lifecycle operation. Both successful and failed
operations rebuild the communication runtime through its existing factory.
The product owns its operation journal, recovery and readiness guard.

Mau is one consumer. Dependencies point from Mau to Router, Host and Environment;
none of these components import Mau. Mau and Router can share a process while
keeping separate HTTP namespaces and state directories. Scheduler is outside this change.
