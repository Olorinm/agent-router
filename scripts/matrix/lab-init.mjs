import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { certificates } from "./lab-certificates.mjs";

const dir = resolve(process.env.MATRIX_LAB_DIR ?? "state/matrix-lab");
if (existsSync(join(dir, "initialized.json"))) throw new Error("Lab already initialized; reuse its keys, identities and stores.");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const write = (path, data, mode = 0o600) => writeFileSync(join(dir, path), typeof data === "string" ? data : JSON.stringify(data, null, 2), { mode, flag: "wx" });
const secret = () => randomBytes(32).toString("hex");
mkdirSync(join(dir, "tls"), { mode: 0o755 });
certificates(dir);
const identities = {};
for (const side of ["a", "b"]) {
  const domain = `matrix-${side}.test`;
  for (const path of [`synapse-${side}`, `pg-${side}`, `connector-${side}`, `agent-${side}`, `secrets-${side}`]) mkdirSync(join(dir, path), { mode: 0o700 });
  const db = secret(), registration = secret();
  write(`secrets-${side}/postgres`, db);
  write(`secrets-${side}/connector`, secret());
  write(`secrets-${side}/agent`, secret());
  write(`secrets-${side}/registration`, registration);
  write(`synapse-${side}/homeserver.yaml`, {
    server_name: domain, public_baseurl: `https://${domain}:8448`, report_stats: false,
    pid_file: "/data/homeserver.pid", signing_key_path: "/data/signing.key",
    listeners: [{ port: 8448, tls: true, type: "http", bind_addresses: ["0.0.0.0"], resources: [{ names: ["client", "federation"], compress: false }] }],
    tls_certificate_path: `/tls/${side}.crt`, tls_private_key_path: `/tls/${side}.key`,
    federation_verify_certificates: true, federation_custom_ca_list: ["/tls/ca.crt"],
    federation_domain_whitelist: ["matrix-a.test", "matrix-b.test"],
    ip_range_whitelist: ["172.30.247.0/24"], trusted_key_servers: [],
    database: { name: "psycopg2", args: { user: "synapse", password: db, database: "synapse", host: `pg-${side}`, cp_min: 2, cp_max: 5 } },
    media_store_path: "/data/media", enable_registration: false, registration_shared_secret: registration,
    macaroon_secret_key: secret(), form_secret: secret(), enable_metrics: false, enable_search: false,
    suppress_key_server_warning: true, max_upload_size: "5M",
    // Private disposable conformance lab: allow burst traffic for history-gap tests.
    rc_message: { per_second: 100, burst_count: 1000 }, rc_invites: { per_room: { per_second: 100, burst_count: 1000 },
      per_user: { per_second: 100, burst_count: 1000 }, per_issuer: { per_second: 100, burst_count: 1000 } },
  });
  identities[side] = { userId: `@agent:${domain}`, homeserver: `https://${domain}:8448` };
}
write("initialized.json", { identities, created: new Date().toISOString(), certificateValidityDays: 30 });
process.stdout.write(`Initialized ${dir}; credentials remain in mode-0600 files.\n`);
