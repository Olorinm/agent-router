import { describe, expect, it } from "vitest";
import { assertSafeEndpoint, isPrivateAddress } from "../src/endpoint-policy.js";

describe("agent endpoint policy", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.1.1", "::1", "fd00::1"])(
    "recognizes private address %s",
    (address) => expect(isPrivateAddress(address)).toBe(true),
  );

  it("requires HTTPS", async () => {
    await expect(assertSafeEndpoint("http://example.com/a2a", { allowHttp: false, allowPrivate: false })).rejects.toThrow(
      "agent_endpoint_https_required",
    );
  });

  it("rejects endpoint credentials embedded in a URL", async () => {
    await expect(assertSafeEndpoint("https://user:pass@example.com/a2a", { allowHttp: false, allowPrivate: false })).rejects.toThrow(
      "agent_endpoint_userinfo_forbidden",
    );
  });
});
