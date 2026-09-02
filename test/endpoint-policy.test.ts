import { describe, expect, it } from "vitest";
import { assertSafeEndpoint, isPrivateAddress } from "../src/endpoint-policy.js";

describe("agent endpoint policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.1.2",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
  ])(
    "recognizes private address %s",
    (address) => expect(isPrivateAddress(address)).toBe(true),
  );

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "recognizes public unicast address %s",
    (address) => expect(isPrivateAddress(address)).toBe(false),
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

  it("rejects an IPv6 loopback URL as private instead of treating it as DNS", async () => {
    await expect(
      assertSafeEndpoint("https://[::1]/a2a", { allowHttp: false, allowPrivate: false }),
    ).rejects.toThrow("agent_endpoint_private_address_forbidden");
  });
});
