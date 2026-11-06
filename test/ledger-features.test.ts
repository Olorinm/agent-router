import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ServiceConfig } from "../src/matrix/managed.js";
import { loadServiceConfig } from "../src/service/config.js";

/** `GET /web/me` → `limits.features` lists every ADR 0005 feature; each flag is independent and off by default. */
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test";
const none = { history: true, send: false, cards: false, attachments: false, reset: false, groups: false, identity: false, matrix: true };

async function features(flags: Partial<ServiceConfig>) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-features-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ...flags }, {
    authenticate: async (token) => { if (token === "alice") return owner; throw new Error("bad_credentials"); }, provision: async () => {} });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/_agent-router/v1/web/me`, { headers: { Authorization: "Bearer alice" } });
  return ((await response.json()) as { limits: { features: Record<string, boolean> } }).limits.features;
}

describe("ledger feature flags", () => {
  it("lists every feature, all off but history by default", async () => {
    expect(await features({})).toEqual(none);
  });
  it("turns on exactly the flagged feature", async () => {
    const send = { ledgerSend: true };
    expect(await features(send)).toEqual({ ...none, send: true });
    expect(await features({ ...send, ledgerCards: true })).toEqual({ ...none, send: true, cards: true });
    expect(await features({ ...send, ledgerControl: true })).toEqual({ ...none, send: true, reset: true });
    expect(await features({ ...send, ledgerGroups: true })).toEqual({ ...none, send: true, groups: true });
    expect(await features({ ...send, ledgerAttachments: true })).toEqual({ ...none, send: true, attachments: true });
    expect(await features({ ledgerIdentity: true })).toEqual({ ...none, identity: true });
    expect(await features({ ...send, ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true, ledgerIdentity: true }))
      .toEqual({ history: true, send: true, cards: true, attachments: true, reset: true, groups: true, identity: true, matrix: true });
  });
  it("reports the deployment's Matrix switch explicitly (ADR 0005 19.1)", async () => {
    expect(await features({ ledgerSend: true, matrix: { enabled: false } })).toEqual({ ...none, send: true, matrix: false });
  });
  it("keeps the send-dependent features off without send", async () => {
    expect(await features({ ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true })).toEqual(none);
  });
  it("sets no ledger flag from an environment without them", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-features-env-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "as"), "a".repeat(48)); writeFileSync(join(dir, "hs"), "h".repeat(48));
    const base = { MATRIX_SERVER_NAME: "example.test", MATRIX_HOMESERVER_URL: "https://example.test", AGENT_SERVICE_URL: "https://example.test/x",
      MATRIX_AS_TOKEN_FILE: join(dir, "as"), MATRIX_HS_TOKEN_FILE: join(dir, "hs") };
    const config = loadServiceConfig(base);
    for (const flag of ["ledgerRead", "ledgerSend", "ledgerCards", "ledgerControl", "ledgerGroups", "ledgerAttachments", "ledgerIdentity"] as const)
      expect(config[flag], flag).toBeUndefined();
    const all = loadServiceConfig({ ...base, AGENT_LEDGER_READ: "1", AGENT_LEDGER_SEND: "1", AGENT_LEDGER_CARDS: "1", AGENT_LEDGER_CONTROL: "1",
      AGENT_LEDGER_GROUPS: "1", AGENT_LEDGER_ATTACHMENTS: "1", AGENT_LEDGER_IDENTITY: "1" });
    expect(all).toMatchObject({ ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true, ledgerGroups: true, ledgerAttachments: true, ledgerIdentity: true });
  });
});
