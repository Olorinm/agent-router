import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { channelModules } from "../src/channels/registry.js";

/**
 * Import boundaries of the channel layer (docs/guides/adding-a-channel.md). They keep each adapter movable into its own
 * package: an adapter reaches Router only through `src/channels/api.ts`, never another adapter, and Router reaches
 * adapters only through `src/channels/registry.ts`.
 */
const root = resolve(import.meta.dirname, ".."), src = join(root, "src"), channels = join(src, "channels");
const api = join(channels, "api.ts"), registry = join(channels, "registry.ts");
/** Router-owned surfaces bound to Router internals (Matrix connector, ledger); they ship with Router. */
const BUILT_IN = new Set(["matrix", "web", "room"]);
/** External adapters: the public API only. Feishu personal tools stay in `src/services/feishu` until they move to connectors. */
const EXTERNAL_EXCEPTIONS: Record<string, string[]> = { feishu: ["src/services/feishu/"] };
/** Router code outside the channel layer that may use one adapter's public entry (kind-specific connection setup). */
const SETUP_EXCEPTIONS: Record<string, string[]> = { "src/connections/connections.ts": ["src/channels/weixin/index.ts"] };

const rel = (path: string) => relative(root, path).split(sep).join("/");
function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}
/** Relative imports (static, re-exports, side-effect, dynamic and `import("…")` types), resolved to source files. */
const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]!)
    .filter((name) => name.startsWith(".")).map((name) => resolve(dirname(file), name.replace(/\.js$/, ".ts")));
}
const adapterOf = (path: string) => {
  const parts = rel(path).split("/");
  return parts[0] === "src" && parts[1] === "channels" && parts.length > 3 ? parts[2] : undefined;
};
const adapters = readdirSync(channels).filter((name) => statSync(join(channels, name)).isDirectory());

describe("channel import boundaries", () => {
  it("every adapter directory exports a module entry and every configurable kind is registered under its own directory", () => {
    for (const kind of adapters) expect(existsSync(join(channels, kind, "index.ts")), kind).toBe(true);
    for (const module of channelModules) expect(adapters).toContain(module.kind);
    expect(adapters.filter((kind) => !BUILT_IN.has(kind) && !channelModules.some((module) => module.kind === kind))).toEqual([]);
  });

  it("an adapter never imports another adapter, and an external adapter reaches Router only through the public API", () => {
    const violations: string[] = [];
    for (const file of files(channels)) {
      const own = adapterOf(file); if (!own) continue;
      for (const target of imports(file)) {
        const other = adapterOf(target), path = rel(target);
        if (other && other !== own) violations.push(`${rel(file)} -> ${path} (another adapter)`);
        else if (target === registry) violations.push(`${rel(file)} -> ${path} (registry)`);
        else if (!other && target !== api && !BUILT_IN.has(own) && !(EXTERNAL_EXCEPTIONS[own] ?? []).some((prefix) => path.startsWith(prefix)))
          violations.push(`${rel(file)} -> ${path} (not the public API)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("Router reaches adapters only through the registry; only the composition root uses the registry", () => {
    const violations: string[] = [];
    for (const file of files(src)) {
      if (rel(file).startsWith("src/channels/")) {
        // The public API stays adapter-free; the registry imports adapter entries only.
        for (const target of imports(file)) {
          if ((file === api || !adapterOf(file) && file !== registry) && adapterOf(target)) violations.push(`${rel(file)} -> ${rel(target)}`);
          if (file === registry && adapterOf(target) && !rel(target).endsWith("/index.ts")) violations.push(`${rel(file)} -> ${rel(target)} (not an entry)`);
        }
        continue;
      }
      for (const target of imports(file)) {
        const path = rel(target);
        if (!path.startsWith("src/channels/") || target === api) continue;
        if (target === registry && rel(file).startsWith("src/service/")) continue;
        if ((SETUP_EXCEPTIONS[rel(file)] ?? []).includes(path)) continue;
        violations.push(`${rel(file)} -> ${path}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the test-only adapter is written against the public API alone", () => {
    const fixture = join(root, "test", "fixtures", "echo-channel", "index.ts");
    expect(imports(fixture).map(rel)).toEqual(["src/channels/api.ts"]);
  });
});
