import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculateJwkThumbprint, exportJWK } from "jose";

const input = resolve(process.argv[2] || "secrets/federation-private-key.pem");
const privateKey = createPrivateKey(await readFile(input, "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("federation_private_key_must_be_ed25519");
const publicJwk = await exportJWK(createPublicKey(privateKey));
const kid = await calculateJwkThumbprint(publicJwk, "sha256");
process.stdout.write(`${JSON.stringify({ keys: [{ ...publicJwk, alg: "EdDSA", kid, use: "sig" }] }, null, 2)}\n`);
