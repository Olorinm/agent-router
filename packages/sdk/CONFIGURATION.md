# Scoped OIDC product integration

Agent Router validates delegated OAuth access tokens with the configured issuer.
It never accepts a primary product login token at `/auth/exchange`. Products own
the native browser/PKCE flow and refresh directly with their account service.
The [SDK README](./README.md) is the client contract.

## Trusted issuer configuration

Mount `AGENT_IDENTITY_CONFIG_FILE` as a private, read-only JSON file:

```json
{
  "my-product": {
    "issuer": "existing-account-namespace",
    "oidcIssuer": "https://identity.example",
    "clientId": "registered-native-client-id",
    "introspectionClientId": "registered-resource-verifier-id",
    "privateJwk": {
      "kty": "EC", "crv": "P-256", "x": "<base64url>", "y": "<base64url>",
      "d": "<base64url private scalar>", "kid": "router-1", "alg": "ES256"
    },
    "requiredRoles": ["agent-network-user"]
  }
}
```

`issuer` is the existing stable account namespace; **retain its exact value**
when migrating from user-info exchange, so owners and contacts keep their IDs.
`oidcIssuer` is the exact HTTPS OIDC issuer. Its discovery must advertise an
introspection endpoint under the same origin. Generate the ES256 key on Router
and register only its public fields (`kty`, `crv`, `x`, `y`, `kid`, `alg`, plus
`use: sig`) with the account service. The private JWK stays in the secret file.
`openid-client` performs discovery and `private_key_jwt` client authentication;
Router validates the introspection response's active status, issuer, native
client ID, exact `AGENT_SERVICE_URL` audience, `router.connect` scope, expiry,
subject and required roles. The issuer must authorize the resource verifier to
inspect only the registered native client's resource-bound grants.

For WW, register a `router-native` client and its `router-verifier` pair before
using the integration. Their IDs are `router-` plus the SHA256 hex digest of the
canonical Router URL, and that ID plus `-verifier`. WW's trusted
`/v1/oauth/router-client?resource=...` metadata resolves the native client. The
native client uses loopback Authorization Code + S256 PKCE, state and nonce.
The verifier uses its registered public ES256 key for introspection only.

`MATRIX_ADMIN_TOKEN_FILE` remains a separate private Synapse admin credential.
It is used only at the configured homeserver's user-admin API. New owners have
no password and `admin=false`; their external binding is verified. A product
role is an eligibility gate, not Matrix administrator status. Disabled or
unrelated Matrix accounts are never adopted. Back up registry and homeserver
together. AS/HS and worker `ari_` credentials are unchanged.

Missing or obsolete provider configuration fails startup. Without the optional
identity configuration, external exchange is disabled. Native Matrix login and
worker instance tokens remain available.

## HTTP contract and lifecycle

`POST /_agent-router/v1/auth/exchange` takes:

```json
{"provider":"my-product","accessToken":"<scoped Router OAuth access token>"}
```

It returns `{serviceUrl, accessToken, expiresAt, owner, agent}`. Router session
hashes and associated scoped credentials live only in memory. Expiry is capped
at ten minutes and at the OAuth token's expiry. Each authenticated request
introspects the grant again: role removal, revocation or account disablement
therefore blocks the next request. Issuer failure returns an explicit 503,
never a cached success. `DELETE /auth/session` revokes locally even during an
issuer outage. Router restart requires another exchange; stable owners, Agents
and durable tasks stay in the registry.

Deploy account-service registrations first, then the new Router configuration
and matching product client. There is no primary-token compatibility fallback.
The exchange endpoint is a Router API, not RFC 8693 or an OIDC authorization
server. OAuth refresh tokens and browser codes must never be sent to Router.

## Local state

Bind contacts/tasks to product account, Router URL, owner and sender. Preserve
message/context/task IDs across recovery and never silently adopt a new sender.
Logs must omit authorization headers, request bodies and OAuth query strings.

Provisioning uses the official
[Synapse user-admin API](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html#create-or-modify-account).
Virtual Agents retain the narrow Matrix Application Service namespace.
