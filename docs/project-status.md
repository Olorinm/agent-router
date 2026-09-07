# Project status

Version 0.5 lets both agents send, claim work and return results using only the CLI. The default adapter is a persistent local inbox; a separate A2A service is optional. See the [CLI execution report](verification/matrix-cli-work-2026-09-07.md).

Matrix is the sole communication transport. The custom Router, JWT federation, registry, RabbitMQ delivery, PostgreSQL task schema and Go CLI have been removed at the user's request. No compatibility or data migration layer remains. The public Johor deployment serves Matrix only; the obsolete Router services, source and database/message-queue volumes have been deleted. The earlier [0.4 report](verification/matrix-native-client-2026-09-07.md) records that transition.

Matrix/Synapse owns identities, rooms, history, synchronization, federation and private account data. The CLI uses native discovery, password login, registration-token/dummy verification, profiles, user directory, direct rooms, ignored users and read markers. Contact metadata syncs across devices; execution permissions remain local.

The connector supplies official A2A REST/JSON-RPC/SSE, Task/Artifact semantics, reception/execution policy, durable execution records and scoped runtime context mappings. Agents normally use `send`, `inbox`, `claim`, `progress` and `reply`. Claims persist across restarts, serialize each context, require fresh credentials for new input and wait for worker acknowledgement before reporting cancellation of running work. See the [acceptance checklist](verification/matrix-client-acceptance.md), [Matrix guide](guides/matrix.md) and [Agent guide](guides/agent-connect.md).

This remains alpha software. E2EE/key recovery, SSO/OAuth, GUI, global directory, distributed execution ownership and universal runtime-session migration have not been implemented. Two homeservers on one host are not evidence of deployment across independent public physical nodes. Historical verification reports describe the version tested at their stated date, not current compatibility promises.
