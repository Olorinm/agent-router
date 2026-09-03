# Production deployment

This guide describes the supported single-host Docker Compose profile. It runs Caddy, Agent Router, PostgreSQL, and RabbitMQ. High-availability orchestration is outside the current release.

## Requirements

- Docker Engine with Docker Compose v2;
- a public DNS name resolving to the host;
- inbound TCP and UDP port 443;
- outbound HTTPS to registered agents, identity infrastructure, and allowed federated Routers;
- Node.js 24 for maintenance commands run outside containers.

The address domain and service hostname may be the same. If they differ, the address domain must serve `/.well-known/agent-router` and delegate to the Router's public base URL.

## Configure

```sh
git clone https://github.com/your-org/agent-router.git
cd agent-router
cp .env.example .env
chmod 600 .env
```

Set operator-owned values in `.env`. At minimum:

```dotenv
ROUTER_HOST=agents.example.com
PUBLIC_BASE_URL=https://agents.example.com
AGENT_ADDRESS_DOMAIN=example.com
ADMIN_AUTH_MODE=userinfo
IDENTITY_USERINFO_URL=https://identity.example.com/oauth2/userinfo
IDENTITY_ADMIN_ROLE=admin
```

Generate independent service passwords and an encryption key:

```sh
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

Do not reuse or commit these values.

## Administrator authentication

### UserInfo mode

`ADMIN_AUTH_MODE=userinfo` forwards the presented bearer token to `IDENTITY_USERINFO_URL`. A successful JSON response must contain `sub`; it may contain `name`, `preferred_username`, `email`, `role`, and `roles`. Administrative access requires the value configured in `IDENTITY_ADMIN_ROLE` to appear in `role` or `roles`.

Example response:

```json
{
  "sub": "operator-123",
  "name": "Example Operator",
  "email": "operator@example.com",
  "roles": ["admin"]
}
```

The endpoint may also wrap this object in `data`.

### Static mode

`ADMIN_AUTH_MODE=static` is suitable for a small controlled installation:

```dotenv
ADMIN_AUTH_MODE=static
STATIC_ADMIN_TOKEN=replace-with-at-least-32-random-characters
STATIC_ADMIN_SUBJECT=primary-operator
STATIC_ADMIN_DISPLAY_NAME=Primary Operator
```

Generate the token with a cryptographically secure random generator. The Router compares it in constant time. Store it as a secret and rotate it after suspected exposure.

## Federation key

The Compose profile mounts `secrets/` whether or not federation is enabled. Generate an Ed25519 key before first start:

```sh
npm ci
npm run build
npm run federation:keygen
chmod 600 secrets/federation-private-key.pem
```

On Linux, ensure the file is readable by UID/GID `1000:1000`, the non-root `node` user in the Router image.

## Start and verify

```sh
docker compose up --detach --build
docker compose ps
curl --fail https://agents.example.com/health/ready
```

Caddy obtains and renews the public certificate. PostgreSQL and RabbitMQ do not publish host ports.

For boot-time management, adjust `WorkingDirectory` in [`deploy/agent-router.service`](../../deploy/agent-router.service), install the unit with systemd, and enable it.

## Operations

- Back up PostgreSQL and `MASTER_ENCRYPTION_KEY_BASE64` together.
- Treat RabbitMQ as a delivery buffer; PostgreSQL is the durable source of truth.
- Monitor Outbox age, dead-letter queues, failed attempts, callback failures, and certificate renewal.
- Synchronize clocks because federation JWTs are short-lived.
- Rotate endpoint, administrator, and machine credentials independently.
- Review [`SECURITY.md`](../../SECURITY.md) before exposing the service.

## Key rotation

Generate the next key separately and publish only its public JWK before switching the active private key:

```sh
npm run federation:keygen -- secrets/federation-next-private-key.pem
npm run federation:jwks -- secrets/federation-next-private-key.pem
```

Keep the previous public key published until the five-minute token window and peer caches have expired. The Router rejects private JWKs in the additional public JWKS file.
