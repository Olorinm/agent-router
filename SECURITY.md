# Security Policy

Agent Router handles authenticated agent traffic, Task history, endpoint credentials, and federation signing keys. Treat every deployment as security-sensitive infrastructure.

## Supported versions

Agent Router is currently pre-1.0 alpha software. Security fixes are applied only to the latest release and the `main` branch.

| Version | Supported |
| --- | --- |
| latest `0.1.x` | yes |
| earlier snapshots | no |

## Project maturity

The project is alpha software and has not received an independent security audit. Deployment defaults do not replace an operator's threat model, network policy, backups, monitoring, or incident response.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Contact the repository owner through a private GitHub security advisory or another private channel agreed by the operator. Include:

- the affected commit or version;
- the affected endpoint or component;
- reproduction steps with secrets removed;
- expected and observed behavior;
- potential impact;
- any suggested mitigation.

Never include production tokens, private keys, Task contents, database dumps, hostnames, IP addresses, or user data unless the receiving private channel has been explicitly approved for that data.

## Secrets that must stay outside Git

- `.env` and environment-specific variants;
- PostgreSQL and RabbitMQ passwords;
- `MASTER_ENCRYPTION_KEY_BASE64`;
- federation private keys and private JWKs;
- Router-issued machine credentials;
- remote agent endpoint credentials;
- push-notification tokens;
- identity-provider access tokens;
- static administrator tokens;
- Codex or other provider login state;
- proxy subscriptions and node credentials;
- database, RabbitMQ, and application state;
- SSH keys, cloud credentials, and deployment inventories.

Only public federation JWKs may be published. A private JWK contains a `d` member and must never be committed or supplied as an additional public rotation key.

The checked-in `.env.demo` is an explicit exception containing only public, disposable values. It binds to loopback and must never be used as the basis for an Internet deployment.

## Repository hygiene

Before every public release:

1. inspect tracked files and ignored files separately;
2. scan the complete Git history, not only the working tree;
3. check commit author metadata;
4. search for real domains, IP addresses, absolute home paths, usernames, email addresses, tokens, private-key markers, database dumps, and login state;
5. verify GitHub Secret Scanning and push protection are enabled;
6. inspect generated archives and container build contexts;
7. verify that examples use reserved `.example` domains and synthetic identities.

Deleting a secret in a later commit does not remove it from Git history. If a real secret was ever committed, revoke or rotate it first, then purge the history and all remote references.

## Deployment baseline

- expose only the TLS ingress port;
- keep PostgreSQL and RabbitMQ on an internal network;
- leave private-address and plaintext-endpoint overrides disabled;
- use a unique master encryption key per deployment;
- store secrets with mode `0600` and restrict host access;
- run the Router as a non-root, read-only container;
- require explicit federation allowlists;
- synchronize system clocks;
- monitor authentication failures, replay rejection, queue age, retries, dead letters, and outbound destination errors;
- back up the encrypted database and its encryption key through separate protected channels;
- rotate credentials after any suspected host or log exposure.

## Trust boundaries

A valid federation JWT proves that a domain signed a claim. It does not independently prove the real-world identity of the remote `sub`. Apply quotas, blocks, abuse controls, and future billing at the issuer-domain boundary.

Agent Cards, discovery documents, callbacks, and remote endpoints are untrusted network input. Do not disable destination validation to make an Internet endpoint work. Fix DNS, TLS, or routing instead.

The Router stores Task content. A2A transport security does not provide end-to-end encryption from caller to worker through the Router. Operators can access data stored by their own Router and must protect it accordingly.
