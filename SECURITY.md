# Security policy

Agent Router 0.5 is a Matrix client with a persistent CLI execution inbox and an optional A2A service adapter. Only the current Matrix implementation is maintained. The custom Router protocol and its credentials are no longer accepted.

Report vulnerabilities privately through the repository owner's GitHub security advisory channel. Do not include real credentials, prompts, Task content, database dumps or deployment identifiers in public issues.

## Credential and execution boundaries

- Matrix passwords stay with the homeserver. Device access/refresh tokens, the gateway token and backend credentials are stored in private local profiles (0700 directories, 0600 files).
- Native account data stores contact metadata and direct rooms. Execution permission is local and is never granted by downloaded contact metadata.
- Blocking uses Matrix ignored users and is enforced again before local execution. Unblocking requires renewed execution authorization.
- Ordinary Matrix messages do not execute a model. A2A requests pass the receiver's permission checks.
- New-device history recovery does not automatically replay historical requests. Unknown external execution acceptance remains uncertain and is never blindly resent. Local CLI acceptance uses a transactional deduplication ledger.
- Run one execution device per Matrix identity. Other devices must not claim the same work; concurrent execution owners and automatic runtime migration are not supported.
- CLI claims persist across restarts, are exclusive to a worker and do not automatically expire. New input requires a fresh claim before completion. Cancellation of claimed work requires the worker to stop and acknowledge it.
- Agent endpoints use fixed-origin authentication and DNS-rebinding protection. Explicit local bindings may use loopback HTTP; arbitrary public endpoint redirects and private addresses are rejected.
- Rooms are currently unencrypted. HTTPS protects transport; homeserver operators can read room content. Encrypted rooms are rejected for task execution and sending until a crypto/key recovery implementation is provided.

Keep Matrix signing keys/databases, profile files, model login state, endpoint tokens, TLS state, SSH/cloud credentials and generated test state out of Git. Back up homeserver state and execution/runtime state consistently. Production stability and an independent security audit have not been claimed.

## Synapse administrative registration MAC

The operator bootstrap and synthetic lab registration scripts implement Synapse's [shared-secret registration API](https://element-hq.github.io/synapse/latest/admin_api/register_api.html). Its protocol requires HMAC-SHA1 over a one-time nonce, username, password and role, keyed by the private registration secret. This authenticates one registration request; it is not a password-storage hash. Synapse [separately hashes the account password in its server implementation](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/rest/admin/users.py).

Changing this MAC to a password KDF or another digest breaks interoperability with unmodified Synapse. Review weak-hash scanner findings at these specific call sites against that protocol; do not disable cryptographic checks globally. Gateway bearer-token authentication uses direct constant-time comparison for equal-length tokens and rejects length mismatches.
