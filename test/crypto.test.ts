import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMachineCredential, decryptSecret, encryptSecret, hashCredential } from "../src/crypto.js";

describe("router secrets", () => {
  it("round-trips encrypted endpoint credentials", () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret("endpoint-secret", key);
    expect(encrypted).not.toContain("endpoint-secret");
    expect(decryptSecret(encrypted, key)).toBe("endpoint-secret");
  });

  it("generates opaque, hashable machine credentials", () => {
    const first = createMachineCredential();
    const second = createMachineCredential();
    expect(first).toMatch(/^ogr_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(hashCredential(first)).toMatch(/^[a-f0-9]{64}$/);
  });
});
