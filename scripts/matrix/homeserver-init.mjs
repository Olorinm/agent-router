import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const serverName = process.argv[2];
if (!serverName || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(serverName)) throw new Error("Usage: homeserver-init.mjs DNS_SERVER_NAME");
const root = resolve(process.env.MATRIX_HOMESERVER_STATE ?? "state/matrix-homeserver");
if (existsSync(root)) throw new Error("Homeserver state already exists; keep its identity, keys and database.");
mkdirSync(root, { recursive: true, mode: 0o700 });
for (const dir of ["synapse", "synapse/media", "postgres", "secrets", "invitations"]) mkdirSync(join(root, dir), { mode: 0o700 });
const write = (path, content) => writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const secret = () => randomBytes(32).toString("hex");
const dbPassword = secret(), registrationSecret = secret();
write("secrets/postgres", dbPassword); write("secrets/registration", registrationSecret);
write("synapse/homeserver.yaml", {
  server_name: serverName, public_baseurl: `https://${serverName}`, report_stats: false,
  signing_key_path: "/data/signing.key", pid_file: "/data/homeserver.pid", media_store_path: "/data/media",
  listeners: [{ port: 8008, tls: false, type: "http", bind_addresses: ["0.0.0.0"], x_forwarded: true,
    resources: [{ names: ["client", "federation"], compress: false }] }],
  database: { name: "psycopg2", args: { user: "synapse", password: dbPassword, database: "synapse", host: "postgres", cp_min: 2, cp_max: 5 } },
  enable_registration: true, registration_requires_token: true, registration_shared_secret: registrationSecret,
  allow_guest_access: false, enable_registration_without_verification: false,
  macaroon_secret_key: secret(), form_secret: secret(), enable_metrics: false,
  max_upload_size: "1M", url_preview_enabled: false, enable_search: false,
});
write("deployment.json", { serverName, createdAt: new Date().toISOString(), registration: "matrix-registration-token" });
process.stdout.write(`Initialized ${serverName} at ${root}. Keep this server name and state when upgrading.\n`);
