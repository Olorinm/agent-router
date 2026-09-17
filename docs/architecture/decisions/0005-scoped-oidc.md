# 0005: Resource-bound OIDC authorization for product accounts

Status: proposed. Issue: https://github.com/Olorinm/agent-router/issues/30

## Context

The user-info adapter receives a product's primary login credential. A product
that lets users select a Router must limit the credential given to that node.
Existing account identifiers and durable work must survive the auth migration.

## Decision

Reuse the account service's OIDC provider. Native clients authorize directly
with PKCE; Router accepts only resource-bound delegated access tokens and uses
its private-key client authentication for introspection. Check issuer, native
client, exact Router audience, scope, expiry, live roles and account state.
Keep the former `issuer` namespace when provisioning owners. Use the maintained
`openid-client` library. Do not provide primary-token fallback.

## Consequences

The issuer must register each Router and confidential verifier. Refresh tokens
remain in the native client. Every authenticated request depends on live
introspection, trading an extra request for immediate revocation and avoiding
stale permission caches. Issuer failure denies the request with 503. Sessions
and delegated credentials remain in memory, so Router restart requires a new
exchange. Contacts, tasks and account ownership remain durable and unchanged.
