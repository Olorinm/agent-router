#!/usr/bin/env node
// Offline, one-time conversion. Never run this against a live Router database.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values: v } = parseArgs({ options: Object.fromEntries(['router-db','worker-db','host-module','host-config','instructions-file','instance-id','out'].map(k => [k, { type: 'string' }])) });
for (const k of ['router-db','worker-db','host-module','host-config','instructions-file','instance-id','out']) if (!v[k]) throw new Error(`--${k} required`);
const sha = s => createHash('sha256').update(s).digest('hex');
const router = new DatabaseSync(v['router-db'], { readOnly: true });
const worker = new DatabaseSync(v['worker-db'], { readOnly: true });
const records = kind => worker.prepare('SELECT id,value FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => ({ id: r.id, ...JSON.parse(r.value) }));
const sessions = new Map(worker.prepare("SELECT id,value FROM records WHERE kind='sessions'").all().map(r => [r.id, JSON.parse(r.value)]));
if (records('runs').some(r => r.phase !== 'finished')) throw new Error('worker_not_idle');
const works = router.prepare("SELECT value FROM documents WHERE collection='cli_work' ORDER BY rowid").all().map(r => JSON.parse(r.value));
if (works.some(w => [2, 7, 8].includes(w.task.status.state))) throw new Error('router_not_idle');
if (router.prepare("SELECT count(*) n FROM documents WHERE collection IN ('execution_sessions','communication_runs')").get().n) throw new Error('host_already_used');
const { FileBindingStore } = await import(pathToFileURL(join(resolve(v['host-module']), 'dist/index.js')));
const { fingerprintJson } = await import(pathToFileURL(join(resolve(v['host-module']), 'dist/codex/index.js')));
const config = JSON.parse(readFileSync(v['host-config'], 'utf8'));
if (config.runtimes.length !== 1 || config.runtimes[0].kernel !== 'codex') throw new Error('one_codex_template_required');
const base = config.runtimes[0], instructions = readFileSync(v['instructions-file'], 'utf8');
const contexts = new Map();
// Multiple old sender-scoped sessions can map to one group context. Continue the
// most recently completed native session; preserve every native rollout in backup.
for (const w of works.sort((a, b) => String(a.task.status.timestamp ?? "").localeCompare(String(b.task.status.timestamp ?? "")))) {
  const oldKey = sha(JSON.stringify([w.source.sender, w.task.contextId]));
  const old = sessions.get(oldKey);
  if (old) contexts.set(w.task.contextId, { oldKey, ...old });
}
const out = resolve(v.out); mkdirSync(out, { mode: 0o700 });
const imports = [];
for (const [contextId, old] of contexts) {
  if (!/^\/workspaces\/[a-f0-9]{64}$/.test(old.cwd) || !/^[a-zA-Z0-9-]+$/.test(old.id)) throw new Error('invalid_native_binding');
  const runtime = { ...base, id: 'continued-' + old.oldKey.slice(0, 24), cwd: old.cwd };
  if (!config.runtimes.some(r => r.id === runtime.id)) config.runtimes.push(runtime);
  const sessionId = 'h-' + sha(JSON.stringify([v['instance-id'], contextId])).slice(0, 40);
  const bindings = new FileBindingStore(join(out, 'host-state/runtimes', sha(runtime.id), 'bindings'));
  await bindings.set(sessionId, { threadId: old.id, fingerprint: fingerprintJson({
    cwd: old.cwd, instructions, tools: [], provider: runtime.thread?.modelProvider,
    config: runtime.thread?.config, command: runtime.command ?? 'codex', args: runtime.args, env: runtime.env,
  }) });
  imports.push({ contextId, instanceId: v['instance-id'], binding: { sessionId, runtimeId: runtime.id, tools: false }, nativeThreadId: old.id });
}
writeFileSync(join(out, 'host.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
writeFileSync(join(out, 'imports.json'), JSON.stringify(imports, null, 2), { mode: 0o600, flag: 'wx' });
writeFileSync(join(out, 'native-sessions.json'), JSON.stringify([...sessions], null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ nativeSessions: sessions.size, continuedContexts: imports.length, runtimeProfiles: config.runtimes.length }));
router.close(); worker.close();
