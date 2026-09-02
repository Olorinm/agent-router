import { describe, expect, it } from "vitest";
import { parseCancelEnvelope } from "../src/delivery.js";

describe("delivery envelopes", () => {
  it("accepts the A2A default empty tenant for cancellation", () => {
    expect(
      parseCancelEnvelope({
        tenant: "",
        ownerPrincipalId: "operator:test",
        routerTaskId: "router-task",
        agentId: "agent-id",
        remoteTaskId: "remote-task",
        attempt: 0,
      }),
    ).toMatchObject({ tenant: "", remoteTaskId: "remote-task" });
  });

  it("still rejects an empty required cancellation identity", () => {
    expect(() =>
      parseCancelEnvelope({
        tenant: "",
        ownerPrincipalId: "operator:test",
        routerTaskId: "",
        agentId: "agent-id",
        remoteTaskId: "remote-task",
      }),
    ).toThrow("cancel_envelope_invalid");
  });
});
