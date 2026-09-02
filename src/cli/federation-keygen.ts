import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exportPKCS8, generateKeyPair } from "jose";

const output = resolve(process.argv[2] || "secrets/federation-private-key.pem");
await mkdir(dirname(output), { recursive: true });
const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
await writeFile(output, await exportPKCS8(privateKey), { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(`${output}\n`);
