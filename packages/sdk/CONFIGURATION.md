# Product account integration

Agent Router is an independent service. An optional HTTP user-info adapter lets a deployed node trust an existing product's account API. This guide ships with the SDK; [README.md](./README.md) is the client contract.

## Configure a trusted provider

Set `AGENT_IDENTITY_CONFIG_FILE` to a private JSON file:

```json
{
  "my-product": {
    "issuer": "https://identity.example",
    "userInfoUrl": "https://identity.example/profile",
    "subjectPath": ["profile", "subject"],
    "rolesPath": ["profile", "permissions"],
    "requiredRoles": ["agent-network-user"]
  }
}
```

Replace this illustrative endpoint, field paths, and required roles with your identity provider's contract. The example expects a response shaped as `{"profile":{"subject":"stable-user-id","permissions":["agent-network-user"]}}`; these names are configurable, not required API fields. HTTPS is required, redirects are rejected, and callers cannot change the configured endpoint or role rule. The server calls it with the submitted product Bearer token. Only a successful response with a stable string subject and all required roles permits provisioning. Missing roles fail closed. Never use display names, email guesses or OS usernames as identifiers. `issuer` is a stable namespace for the account system; changing it deliberately creates a separate identity namespace.

Set `MATRIX_ADMIN_TOKEN_FILE` to a private file containing a Synapse admin token. It remains on the node and is used only at the configured homeserver's user-admin API. This is separate from the existing AS and HS tokens. The account is created **without a password and with admin=false**, and its external identity binding is verified. The configured product role is an eligibility gate, not Matrix administrator status. The adapter will not attach to an unrelated existing account, reactivate a disabled owner, or copy arbitrary profile data. The registry and homeserver should be backed up together.

Without `AGENT_IDENTITY_CONFIG_FILE`, external login is disabled; regular Matrix login and instance tokens work as before. With it set, a missing admin secret or invalid provider configuration fails startup rather than silently weakening authentication. Production deployment must mount both files read-only. Do not expose the Synapse admin API publicly or put its token in a client.

## Public HTTP contract

`POST /_agent-router/v1/auth/exchange`

```json
{"provider":"my-product","accessToken":"<current product login token>"}
```

Returns a non-cacheable response with `{serviceUrl,accessToken,expiresAt,owner,agent}`. The `agent` object includes `id`, `owner`, `name`, `address`, `matrixId`, and may include extra server metadata. Existing external identity and default `client` Agent are reused on repeated/concurrent exchanges. The opaque Router session expires after ten minutes. Only its hash is stored; product tokens are neither persisted nor returned. A revoked product role prevents renewal, while previously issued Router sessions live for at most their remaining lifetime. `DELETE /_agent-router/v1/auth/session` with the Router Bearer token revokes that session.

This is a configured user-info exchange, **not** an OIDC provider or an implementation of RFC 8693. Additional products can configure their own endpoints, response field paths and required roles; core account/messaging code has no dependency on any particular product API or database schema.

## Keep product state safe

Bind local contacts and pending tasks to product account + Router owner + sender Agent + service URL. Never silently migrate a conversation to another account. Preserve message IDs, task IDs and context IDs across recovery. Show transport/task progress separately from actual reply content. An SDK caller should be able to use the package without installing the CLI or reading private server implementations.

## Source

The provisioning adapter uses the official [Synapse user-admin API](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html#create-or-modify-account). Agent virtual identities still use the existing narrow Matrix Application Service namespace.
