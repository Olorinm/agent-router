# One-time Codex worker migration

These operator scripts are not a running compatibility layer. The retired worker
is absent from the application, examples and deployment path. Keep a private
backup and stop the old worker before exporting; stop Router before changing its
SQLite database. Queued messages may remain, but active or uncertain execution
must be reconciled first.

1. Snapshot both SQLite databases and preserve native Codex home, workspaces,
   projects, and complete CLI config/data directories. Exclude Router instance
   credentials. Preserve the original paths and native kernel version for the
   first resume when possible.
2. Issue a `channel-host` instance. Prepare a private Host config with one Codex
   runtime and a separate instructions file. Run `codex-sessions.mjs --router-db
   SNAPSHOT --worker-db SNAPSHOT --host-module PINNED_HOST_PACKAGE --host-config
   CONFIG --instructions-file INSTRUCTIONS --instance-id ID --out NEW_DIRECTORY`.
   It uses Agent Host's public binding store and fingerprint function.
3. Copy generated bindings into the Host state directory and use the generated
   runtime profiles. Create an operator-owned archive containing `codex-home`,
   `workspaces`, `projects`, `state/lark`, and
   `home/user/.agent-host-service/state`. Inspect symlinks before packaging: the
   archive must come from a trusted operator, not an uploaded user attachment.
   Upload it and its SHA-256 manifest through private environment profile files.
   A migration template can invoke `restore-once.sh` after `ready.json` is present.
4. With Router stopped, transactionally import `imports.json`: store each
   `binding` in `documents('execution_sessions', contextId)` and each `instanceId`
   in `documents('context_workers', contextId)`. Refuse conflicting existing
   bindings. Do not replay or rewrite historical tasks/claims. Keep an audit copy.
5. Remove obsolete `hosts` from onboarding options. Add the private environment
   profile with its Host config, instructions and files, then start Router and
   run `agent-router environment-create PROFILE` for the existing Agent.
6. Verify native `session.bound` reports the original thread ID with `resumed:
   true`, actual model execution, installed CLI authorization, MCP connectivity,
   original channel identity, and persistence after environment pause/resume.
   Retire the old worker only after acceptance. Restore the backup if acceptance
   fails; never run old and new workers concurrently.

Old `codex exec` threads cannot acquire dynamic tools through Codex's public
`thread/resume` API. Imported sessions therefore explicitly disable Host dynamic
tools; their original native CLI/MCP tools remain available. Fresh sessions use
all configured Host tools. Multiple old sender-scoped threads in one group are
preserved, while the latest completed thread continues that shared group context.
Do not present the archived threads as a merged transcript.

Keep archives, generated configs, credentials, databases and audit files outside
Git, with restrictive permissions. The application does not automatically run
these scripts or inspect old worker state.
