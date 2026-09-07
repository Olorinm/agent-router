# ADR 0003: Standalone Go CLI with the existing communication service

- Status: Accepted by the user, 2026-09-07
- Implementation: 0.6

The user requested retaining a Go CLI when adopting Matrix. Matrix does not impose an implementation language. The CLI is now a native Go executable; the existing TypeScript Matrix/A2A service continues to own synchronization, routing, permissions, claims, task state and recovery.

The Go CLI directly implements the bounded account operations from the [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/): discovery, password login, registration-token/dummy UIA, identity verification, logout, directory and profile operations. It does not implement federation, room synchronization or task execution. Message/task calls use the [official A2A Go SDK v2.5.0](https://github.com/a2aproject/a2a-go/tree/v2.5.0), supporting A2A 1.0, against the existing SDK-backed local gateway. Local work/contact/event APIs remain part of this application's service and do not replace the A2A protocol.

Both components use the current profile schema and SQLite profile-owner ledger. This is shared active state, not a revival of the old Router protocol or a legacy migration layer. Account-changing commands require exclusive ownership, and an active connector prevents concurrent login/logout, token rotation or backend rebinding. Atomic 0600 credential files and 0700 directories are retained. Read-only CLI commands can run while the service owns the profile.

The Go binary runs without Go, Node or npm and embeds the Agent guide. We publish macOS/Linux amd64/arm64 builds with CGO disabled. Windows is not included in this release because the profile ownership and process-replacement implementation uses POSIX facilities. The Node package now installs only `agent-router-connector`. `agent-router connect` starts that separate executable, or a configured JavaScript entry with Node 24. The service host still needs Node; the binary does not embed or download Node at runtime. A client of an already deployed authenticated gateway needs only the Go executable.

The TypeScript user-facing CLI is removed to avoid maintaining two implementations of every command. No custom Router accounts, JWT federation, RabbitMQ transport, old Go command semantics or migration data are restored. Synapse deployment and federation are unchanged.

Validation must include the compiled Go executable crossing the TypeScript gateway, account security and cross-process locking, context/task/message identifiers, approval/claim/progress/reply, input continuation, cancellation, native contacts/events, and restart/offline recovery on real Synapse servers. The existing JavaScript service tests remain required. CI's `cli` check now compiles, tests and packages Go; cryptographic scanning stays enabled for both languages.
