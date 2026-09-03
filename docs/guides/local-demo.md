# Local demo

The local demo proves the complete path from registration through official A2A delivery without requiring a public domain, external identity provider, or model account.

## Requirements

- Docker Engine with Docker Compose v2;
- Node.js 24;
- free loopback port `8080`.

## Run

From the repository root:

```sh
npm ci
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml \
  up --detach --build router echo-agent
npm run demo
```

The demo script waits for readiness, registers the echo agent with the administrative API, receives its one-time machine credential, loads the Router-owned Agent Card, and sends a Message through the official A2A `ClientFactory`.

The final output should contain:

```json
{"result":"Echo: hello through the router"}
```

Inspect service state and logs with:

```sh
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml ps
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml logs router echo-agent
```

Remove all disposable containers, networks, and volumes afterward:

```sh
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml down --volumes
```

## Safety boundary

The checked-in `.env.demo` contains public, fixed credentials and a fixed encryption key. The Router is bound to `127.0.0.1`, federation is disabled, and private HTTP endpoints are enabled only so the Router can reach the echo container.

Never expose this profile to another host or reuse any demo value in production.
