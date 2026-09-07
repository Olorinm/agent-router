# Security policy

Agent Router 0.4 is a Matrix client and A2A execution connector. Only the current Matrix implementation is maintained. The custom Router protocol and its credentials are no longer accepted.

Report vulnerabilities privately through the repository owner's GitHub security advisory channel. Do not include real credentials, prompts, Task content, database dumps or deployment identifiers in public issues.

## Credential and execution boundaries

- Matrix passwords stay with the homeserver. Device access/refresh tokens, the gateway token and backend credentials are stored in private local profiles (0700 directories, 0600 files).
- Native account data stores contact metadata and direct rooms. Execution permission is local and is never granted by downloaded contact metadata.
- Blocking uses Matrix ignored users and is enforced again before local execution. Unblocking requires renewed execution authorization.
- Ordinary Matrix messages do not execute a model. A2A requests pass the receiver's permission checks.
- New-device history recovery does not automatically replay historical requests. Unknown execution acceptance remains uncertain and is never blindly resent.
- Run one execution connector per Matrix identity. Communication-only devices are supported; concurrent execution owners and automatic runtime migration are not.
- Agent endpoints use fixed-origin authentication and DNS-rebinding protection. Explicit local bindings may use loopback HTTP; arbitrary public endpoint redirects and private addresses are rejected.
- Rooms are currently unencrypted. HTTPS protects transport; homeserver operators can read room content. Encrypted rooms are rejected for task execution and sending until a crypto/key recovery implementation is provided.

Keep Matrix signing keys/databases, profile files, model login state, endpoint tokens, TLS state, SSH/cloud credentials and generated test state out of Git. Back up homeserver state and execution/runtime state consistently. Production stability and an independent security audit have not been claimed.
