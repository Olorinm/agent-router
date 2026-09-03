# Register and call an agent

An agent must expose at least one reachable A2A v1 interface before registration. The Router stores its official Agent Card and may store an encrypted endpoint bearer credential used only for Router-to-agent calls.

The supported path for an independent operator is the standalone CLI and a one-time invitation. An administrator first runs `agent-router invite ADDRESS ENDPOINT`, sends the resulting invitation privately, and the worker operator joins interactively:

```sh
agent-router join
```

The invitation carries the Router location and scoped enrollment secret. The CLI asks for the Agent Card URL, validates it, registers the exact invited address and endpoint origin, and stores the returned machine credential. See the [CLI guide](cli.md) for interactive and automated forms.

The raw HTTP example below is retained as an API reference for Router administrators and custom automation.

## Register

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $ADMIN_TOKEN" \
  --header "Content-Type: application/json" \
  --data @- \
  https://agents.example.com/v1/agents <<'JSON'
{
  "address": "writer",
  "displayName": "Example Writer",
  "description": "Produces short editorial drafts.",
  "endpointBearerToken": "replace-with-the-agent-endpoint-token",
  "agentCard": {
    "name": "Example Writer",
    "description": "Produces short editorial drafts.",
    "supportedInterfaces": [
      {
        "url": "https://worker.example.net/a2a/rest",
        "protocolBinding": "HTTP+JSON",
        "protocolVersion": "1.0"
      }
    ],
    "provider": {
      "organization": "Example Operator",
      "url": "https://worker.example.net"
    },
    "version": "1.0.0",
    "capabilities": {
      "streaming": false,
      "pushNotifications": false,
      "extendedAgentCard": false
    },
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/plain"],
    "skills": [
      {
        "id": "draft",
        "name": "Draft",
        "description": "Writes a short draft from a brief.",
        "tags": ["writing"]
      }
    ]
  }
}
JSON
```

The Router appends `AGENT_ADDRESS_DOMAIN` when `address` is only a local part. The response contains the final address, Router-owned Agent Card, and a machine credential shown exactly once. Save that credential in a secret manager; only its hash is stored in PostgreSQL.

## Call

Load the returned Card and use an official A2A client. Do not construct Message or Task URLs manually.

The included operational helper also uses the official `ClientFactory`:

```sh
ROUTER_AGENT_CARD_URL=https://agents.example.com/agents/writer%40example.com/.well-known/agent-card.json \
ROUTER_CREDENTIAL_FILE=/secure/path/writer.credential \
ROUTER_PROMPT='Write a two-sentence introduction.' \
npm run send
```

## Address meaning

`writer@example.com` means that the Router responsible for `example.com` allocated the identifier `writer`. It does not imply that the worker runs on that domain. The worker can move without changing its public address or Router Card URL.
