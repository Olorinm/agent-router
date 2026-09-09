# Contributing

Agent Router welcomes focused bug reports, documentation improvements, tests, and implementation changes that preserve the Matrix and A2A interoperability boundaries.

## Before opening an issue

- Search existing issues and architecture decisions.
- Remove credentials, real Task content, private hostnames, IP addresses, and deployment data.
- For security problems, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.
- State the implementation version, A2A wire version, and Federation Profile version when relevant.

## Development setup

To install a released CLI and connector without building, use the [installation guide](docs/guides/install.md) or run `sh scripts/install.sh` from this checkout. Source changes to the embedded Agent guides require rebuilding the Go binary. Keep the [English](docs/guides/agent-connect.en.md) and [Chinese](docs/guides/agent-connect.md) guides and the [CLI contract](docs/guides/cli-contract.md) consistent with changed behavior.

Requirements are Go 1.25+ (the module selects the tested toolchain), Node.js 24 for the communication service, and Docker Compose v2 for real federation checks.

```sh
go test -race ./...
sh scripts/build-cli.sh
npm ci
npm run typecheck
npm test
npm run build
```

Use the Matrix lab documented in [Conformance](docs/conformance.md) for end-to-end checks.

## Change process

1. Open an issue before a large feature or protocol-affecting change.
2. Keep A2A models and transport behavior in the official SDK.
3. Add or update an ADR for a durable architectural choice.
4. Update the normative federation specification for wire-visible federation changes.
5. Add conformance cases and tests with synthetic identities and `.example` domains.
6. Keep commits focused and explain security consequences.

Changes must not introduce private Message, Task, Artifact, Agent Card, REST, or JSON-RPC substitutes for official A2A behavior.

## Pull requests

A pull request should include:

- the problem and chosen approach;
- user-visible or interoperability impact;
- tests performed;
- configuration and documentation changes;
- security, privacy, migration, and rollback considerations when applicable.

By contributing, you agree that your contribution is licensed under the repository's Apache License 2.0.
