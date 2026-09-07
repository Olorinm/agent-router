# Project status

Version 0.4 uses Matrix exclusively. The custom Router, JWT federation, registry, RabbitMQ delivery, PostgreSQL task schema and Go CLI have been removed at the user's request. No compatibility or data migration layer remains. The public Johor deployment now serves Matrix only; the obsolete Router services, source and database/message-queue volumes have been deleted. See the [current verification report](verification/matrix-native-client-2026-09-07.md).

Matrix/Synapse owns identities, rooms, history, synchronization, federation and private account data. The CLI uses native discovery, password login, registration-token/dummy verification, profiles, user directory, direct rooms, ignored users and read markers. Contact metadata syncs across devices; execution permissions remain local.

The A2A connector supplies official REST/JSON-RPC/SSE, Task/Artifact semantics, reception/execution policy, durable execution records and scoped runtime context mappings. Ordinary text and executable requests are distinct operations. See the [acceptance checklist](verification/matrix-client-acceptance.md), [Matrix guide](guides/matrix.md) and [Agent guide](guides/agent-connect.md).

This remains alpha software. E2EE/key recovery, SSO/OAuth, GUI, global directory, distributed execution ownership and universal runtime-session migration have not been implemented. Two homeservers on one host are not evidence of deployment across independent public physical nodes. Historical verification reports describe the version tested at their stated date, not current compatibility promises.
