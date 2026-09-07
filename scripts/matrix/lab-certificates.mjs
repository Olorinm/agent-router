import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Explicit extensions are required by strict verifiers such as Python 3.13's SSL defaults.
export function certificates(dir, reuseKeys = false) {
  const openssl = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "tls/ca.cnf"), `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Agent Router private federation test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n`, { mode: 0o600 });
  openssl(["req", "-x509", ...(reuseKeys ? ["-key", "tls/ca.key"] : ["-newkey", "rsa:2048", "-keyout", "tls/ca.key"]),
    "-sha256", "-days", "30", "-nodes", "-out", "tls/ca.crt", "-config", "tls/ca.cnf"]);
  chmodSync(join(dir, "tls/ca.key"), 0o600); chmodSync(join(dir, "tls/ca.crt"), 0o644);
  for (const side of ["a", "b"]) {
    writeFileSync(join(dir, `tls/${side}.ext`), `subjectAltName=DNS:matrix-${side}.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`, { mode: 0o600 });
    openssl(["req", "-new", ...(reuseKeys ? ["-key", `tls/${side}.key`] : ["-newkey", "rsa:2048", "-nodes", "-keyout", `tls/${side}.key`]),
      "-out", `tls/${side}.csr`, "-subj", `/CN=matrix-${side}.test`]);
    openssl(["x509", "-req", "-in", `tls/${side}.csr`, "-CA", "tls/ca.crt", "-CAkey", "tls/ca.key", "-CAcreateserial",
      "-out", `tls/${side}.crt`, "-days", "30", "-sha256", "-extfile", `tls/${side}.ext`]);
    chmodSync(join(dir, `tls/${side}.key`), 0o600); chmodSync(join(dir, `tls/${side}.crt`), 0o644);
  }
}
