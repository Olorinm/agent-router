# Configuration reference

All configuration is provided through environment variables. Empty optional variables are treated as unset.

## Core

| Variable | Purpose | Default |
| --- | --- | --- |
| `ROUTER_HOST` | Caddy public hostname | required by Compose |
| `PUBLIC_BASE_URL` | absolute Router origin | required |
| `AGENT_ADDRESS_DOMAIN` | domain appended to local addresses | required |
| `DATABASE_URL` | PostgreSQL connection string | required |
| `RABBITMQ_URL` | RabbitMQ connection string | required |
| `MASTER_ENCRYPTION_KEY_BASE64` | exactly 32 random bytes in Base64 | required |
| `PORT` | internal HTTP port | `8080` |
| `TRUST_PROXY` | trusted Express proxy hops | `1` |

## Administrator authentication

| Variable | Purpose | Default |
| --- | --- | --- |
| `ADMIN_AUTH_MODE` | `userinfo` or `static` | `userinfo` |
| `IDENTITY_USERINFO_URL` | exact bearer-token UserInfo endpoint | required in `userinfo` mode |
| `IDENTITY_ADMIN_ROLE` | role required for administration | `admin` |
| `STATIC_ADMIN_TOKEN` | administrator bearer token, at least 32 characters | required in `static` mode |
| `STATIC_ADMIN_SUBJECT` | stable local administrator identifier | `local-admin` |
| `STATIC_ADMIN_DISPLAY_NAME` | local administrator display name | `Local Administrator` |
| `AUTH_CACHE_TTL_MS` | successful local authentication cache | `30000` |

Federation JWTs are never stored in this cache because each `jti` must be claimed exactly once.

## Delivery

| Variable | Purpose | Default |
| --- | --- | --- |
| `DELIVERY_CONCURRENCY` | concurrent delivery dispatcher slots | `4` |
| `DELIVERY_TIMEOUT_MS` | timeout for one remote acceptance or Task polling request | `300000` |
| `DELIVERY_MAX_ATTEMPTS` | maximum delivery attempts | `12` |
| `DELIVERY_RETRY_BASE_MS` | retry backoff base | `5000` |
| `ALLOW_HTTP_AGENT_ENDPOINTS` | allow plaintext agent endpoints | `false` |
| `ALLOW_PRIVATE_AGENT_ENDPOINTS` | allow private or reserved destination IPs | `false` |

The two endpoint-policy overrides are intended only for controlled development networks.

## Federation

| Variable | Purpose | Default |
| --- | --- | --- |
| `FEDERATION_ENABLED` | publish and accept federation | `false` |
| `FEDERATION_PRIVATE_KEY_FILE` | active Ed25519 private key | `/run/secrets/federation-private-key.pem` |
| `FEDERATION_ADDITIONAL_JWKS_FILE` | optional public-only rotation keys | unset |
| `FEDERATION_TOKEN_TTL_SECONDS` | JWT lifetime, maximum 300 | `300` |
| `FEDERATION_CLOCK_TOLERANCE_SECONDS` | verifier clock tolerance | `15` |
| `FEDERATION_DISCOVERY_CACHE_MS` | discovery cache lifetime | `300000` |
| `FEDERATION_REMOTE_CARD_CACHE_MS` | remote Card cache lifetime | `60000` |
| `REMOTE_TASK_POLL_MS` | interval for recovering accepted remote Tasks when push is absent or delayed | `30000` |
| `FEDERATION_REQUESTS_PER_MINUTE` | inbound limit per issuer domain | `120` |
