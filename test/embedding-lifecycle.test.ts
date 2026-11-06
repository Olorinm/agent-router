import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouter } from "../src/server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "embedded-router-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const router = createRouter({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48) });
  cleanup.push(() => router.close());
  return router;
}
it("embedded Router starts once and refuses to start after close", async () => {
  const router = fixture();
  const start = vi.spyOn(router.service, "start").mockResolvedValue();
  await Promise.all([router.start(), router.start()]);
  expect(start).toHaveBeenCalledOnce();
  await router.close();
  await expect(router.start()).rejects.toThrow("router_closed");
});
it("closing during startup waits for the start to settle", async () => {
  const router = fixture(); let release!: () => void;
  vi.spyOn(router.service, "start").mockImplementation(() => new Promise<void>((r) => { release = r; }));
  const close = vi.spyOn(router.service, "close");
  const started = router.start(), closed = router.close();
  expect(close).not.toHaveBeenCalled();
  release(); await Promise.all([started, closed]);
  expect(close).toHaveBeenCalledOnce();
});
