# Managed Agents under Matrix owner accounts

Status: implemented in source; supersedes the one-Matrix-account-per-Agent onboarding in ADR 0002.

A human logs in once through Matrix. The local Agent service verifies that session
against its configured homeserver's `account/whoami`, never an arbitrary URL provided
by a caller. Owner tokens are not stored. Remote homeserver accounts cannot create
Agents on this service; they use their own node and communicate through federation.

The durable registry records owner MXID → logical Agent UUID → runtime instance UUID.
Agent names are unique under their owner. Friendly addresses are `owner/name@server`;
the exact-address public directory maps them to the namespace-owned virtual MXID.
Name resolution uses HTTPS without credentials; Matrix handles subsequent delivery.

The homeserver administrator installs an Application Service with a narrow exclusive
user namespace. The gateway provisions passwordless virtual users with
`m.login.application_service` and `inhibit_login`, and acts as each user using the
AS token and `user_id`. Ordinary accounts are never in that namespace. The AS token
is only present on the node. The separate HS token authenticates callbacks.

Incoming AS transactions commit their deduplication hash, room-membership routing
state and per-Agent journal batches in one SQLite transaction before acknowledgement.
Each Agent's existing connector consumes this journal instead of polling `/sync`.
Its receipt checkpoint still commits with task ingestion, so a crash between the
two databases causes replay and deduplication, not event loss. Model execution never
blocks the AS acknowledgement. Outgoing Matrix events retain stable transaction IDs.

Each Agent has its own connector/task store, native sender, contacts, execution policy
and room history. The existing A2A adapter and CLI work engine are reused. The owner
can manage those settings through the gateway; an instance has a restricted API.
Instance tokens are random, stored only as SHA-256 digests, scoped to one Agent and
revocable/rotatable. Request bodies cannot choose a different worker identity. Claim
updates verify the instance even when retrying an already completed result receipt.

The first claimant pins a context to an instance. Different contexts can run on
different instances, but one context has at most one active claimant. Claims do not
expire or migrate. Rotating credentials for the same instance preserves its ID and
bindings; the operator must also preserve actual model state. Revocation blocks
network access and requests cancellation, but is not proof an external process has
stopped. This implementation provides no automatic crash takeover or exactly-once
external side effects. One active Agent service process per node is supported.

Matrix account credentials remain in the Go account profile. A separate Agent
selection file contains either a reference to an owned Agent or a scoped instance
credential. Managed clients only need the Go binary. Native single-identity connector
mode remains available for protocol interoperability and the existing conformance lab.
No migration from historical independent demo accounts to owned Agents is inferred.

Reply-policy customization is deliberately outside this change. Receiving permission,
execution permission and explicit runtime reply commands retain their current behavior.

References: [Matrix Application Services](https://spec.matrix.org/latest/application-service-api/),
[passwordless virtual user provisioning](https://spec.matrix.org/latest/application-service-api/#server-admin-style-permissions),
[transaction delivery](https://spec.matrix.org/latest/application-service-api/#pushing-events).
