// A supervised Codex worker using the public Agent Router CLI only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const state = process.env.WORKER_STATE_DIR ?? '/state';
const workspaceRoot = process.env.WORKER_WORKSPACE_DIR ?? '/workspaces';
const projectsRoot = process.env.WORKER_PROJECTS_DIR;
mkdirSync(state, { recursive: true, mode: 0o700 });
mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(state, 'worker.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id))');
const get = (kind, id) => {
  const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
  return row ? JSON.parse(row.value) : undefined;
};
const put = (kind, id, value) => db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value')
  .run(kind, id, JSON.stringify(value));
function modelConnectionFailure(message) {
  if (typeof message !== 'string') return undefined;
  if (/tls|certificate|handshake/i.test(message)) return 'tls';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/connect|socket|stream disconnected/i.test(message)) return 'connection';
  return undefined;
}
const log = (event, data = {}) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n');
const router = process.env.AGENT_ROUTER_BIN ?? 'agent-router';
const worker = process.env.WORKER_NAME ?? 'codex-service';
const containerIsolation = process.env.CODEX_CONTAINER_ISOLATION === '1';
if (containerIsolation && (!existsSync('/.dockerenv') || process.getuid?.() === 0)) {
  throw new Error('container_isolation_requires_a_non_root_container');
}
let stopping = false, runningChild;

function stopChild() {
  if (!runningChild) return;
  const child = runningChild;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
  child.once('close', () => clearTimeout(force));
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; stopChild(); });

async function cli(args, input) {
  const child = spawn(router, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { err = (err + b).slice(-4000); });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) {
    const error = new Error('router_command_failed');
    error.detail = err; // Only inspected locally; never copied to peer responses.
    throw error;
  }
  return out.trim() ? JSON.parse(out) : null;
}

async function runCodex(work, key) {
  const prior = get('sessions', key);
  const cwd = join(workspaceRoot, key);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // In the supplied Compose deployment, Docker enforces the execution boundary.
  // Otherwise retain Codex's workspace sandbox; never silently fall back on failure.
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--sandbox', containerIsolation ? 'danger-full-access' : 'workspace-write',
    ...(process.env.CODEX_MODEL ? ['--model', process.env.CODEX_MODEL] : []),
    ...(prior ? ['resume', prior.id] : []), '--skip-git-repo-check', '--json', '-'];
  // Do not inherit Matrix/gateway credentials or operator configuration.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const child = spawn(process.env.CODEX_BIN ?? 'codex', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  runningChild = child;
  let pending = '', text = '', bytes = 0, completed = false, failed = false, cancelled = false, timedOut = false;
  let session = prior?.id, tools = 0, connectionFailure;
  let progressUpdates = Promise.resolve(), lastProgress = '';
  const reportConnectionProgress = (text) => {
    if (text === lastProgress) return;
    lastProgress = text;
    progressUpdates = progressUpdates.then(() => cli(['progress', work.claimId, text]))
      .catch(error => log('codex.progress_failed', { taskId: work.id, reason: error.code ?? error.message }));
  };
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timeout = setTimeout(() => { timedOut = true; stopChild(); }, Number(process.env.CODEX_TIMEOUT_MS ?? '240000'));
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4_000_000) { failed = true; stopChild(); return; }
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') {
          if (typeof event.thread_id !== 'string' || (prior && prior.id !== event.thread_id)) { failed = true; stopChild(); }
          else { session = event.thread_id; put('sessions', key, { id: session, cwd }); }
        }
        if (event.type === 'error') {
          const reason = modelConnectionFailure(event.message);
          if (reason) {
            connectionFailure = reason;
            if (!lastProgress) log('codex.connection_retry', { taskId: work.id, reason });
            reportConnectionProgress('远端模型连接中断，正在重试。');
          }
        }
        if ((event.type === 'item.started' || event.type === 'item.completed') && connectionFailure) {
          connectionFailure = undefined;
          reportConnectionProgress('远端模型连接已恢复，正在处理。');
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
        if (event.type === 'item.completed' && ['command_execution', 'file_change'].includes(event.item?.type)) tools++;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed') {
          failed = true;
          connectionFailure = modelConnectionFailure(event.error?.message) ?? connectionFailure;
        }
      } catch { failed = true; stopChild(); }
    }
  });
  child.stderr.resume();
  const message = work.input.parts?.map(part => typeof part.text === 'string' ? part.text : JSON.stringify(part.data ?? part)).join('\n') ?? '';
  const projects = projectsRoot ? `\nShared project checkouts are available at ${projectsRoot}. You may read and modify them when the owner requests project work. Read a repository's AGENTS.md before working there. These checkouts persist across conversations; preserve existing changes.` : '';
  child.stdin.end(`You are a real remote Codex agent serving an explicitly approved owner through Agent Router.\nWork in the current persistent workspace. Use tools when the request needs execution; distinguish actual execution from advice. Reply in the user's language. Your final response is delivered to the requesting agent. You do not need to call Agent Router yourself. Do not inspect authentication files, service configuration, or other conversation directories.${projects}\n\nLatest request:\n${message}`);
  let monitorStopped = false;
  const monitor = (async () => {
    while (!monitorStopped && !stopping) {
      await delay(1000);
      if (monitorStopped) break;
      try {
        const current = await cli(['work', work.claimId]);
        if (current.cancelRequested) { cancelled = true; stopChild(); break; }
      } catch (error) {
        if (/instance_unauthorized|claim_belongs_to_another_instance/.test(error.detail ?? '')) {
          cancelled = true; stopChild(); break;
        }
        // Transient gateway restarts do not imply cancellation.
      }
    }
  })();
  try {
    const code = await closed;
    await progressUpdates;
    if (code === 0 && completed && !failed && Buffer.byteLength(text) > 12000) {
      const outputPath = join(cwd, `response-${work.claimId}.md`);
      writeFileSync(outputPath, text, { mode: 0o600 });
      let excerpt = '', size = 0;
      for (const character of text) {
        size += Buffer.byteLength(character);
        if (size > 10000) break;
        excerpt += character;
      }
      text = `${excerpt}\n\n[回复较长，完整内容已保存于远程工作区 ${outputPath}；可在同一会话要求提取指定部分。]`;
    }
    return { action: cancelled ? 'cancelled' : code === 0 && completed && !failed && text && session ? 'reply' : 'fail',
      text: cancelled ? '' : code === 0 && completed && !failed && text && session ? text : connectionFailure ? '远端模型连接失败，本次执行已停止；会话已保留，可稍后继续。' : timedOut ? '本次 Codex 执行超时，已停止；可在同一会话继续。' : '本次 Codex 执行未完成；服务保留了已有会话，请稍后继续。',
      session, tools, code, timedOut, completed, failed };
  } finally {
    monitorStopped = true; clearTimeout(timeout); runningChild = undefined; await monitor;
  }
}

const heartbeat = setInterval(() => writeFileSync(join(state, 'heartbeat'), String(Date.now()), { mode: 0o600 }), 10000);
writeFileSync(join(state, 'heartbeat'), String(Date.now()), { mode: 0o600 });
log('worker.started', { worker });
try {
  while (!stopping) {
    try {
      const work = await cli(['claim', '--worker', worker, '--wait', '20']);
      if (!work || stopping) continue;
      const key = createHash('sha256').update(JSON.stringify([work.from, work.contextId])).digest('hex');
      let record = get('runs', work.claimId);
      if (work.cancelRequested) record = { action: 'cancelled', text: '' };
      else if (record?.phase === 'running') {
        // A crashed tool may have produced side effects: never silently replay it.
        record = { action: 'fail', text: '服务在上次执行期间中断，未自动重复执行。请在同一会话确认进度后继续。' };
      }
      if (!record) {
        put('runs', work.claimId, { phase: 'running', contextId: work.contextId, taskId: work.id });
        await cli(['progress', work.claimId, '远程 Codex 已接收，正在处理。']);
        log('codex.started', { taskId: work.id, contextId: work.contextId, resumed: Boolean(get('sessions', key)) });
        record = await runCodex(work, key);
        put('runs', work.claimId, { ...record, phase: 'finished', contextId: work.contextId, taskId: work.id });
        log('codex.finished', { taskId: work.id, action: record.action, session: record.session, tools: record.tools, code: record.code });
      }
      if (stopping) break;
      const current = await cli(['work', work.claimId]);
      if (current.cancelRequested) await cli(['cancelled', work.claimId]);
      else if (!current.newInput) await cli([record.action, work.claimId, '-'], record.text);
      // A new input revision is claimed on the next iteration; stale output is not published.
    } catch (error) {
      log('worker.retry', { reason: error.code ?? error.message });
      await delay(2000);
    }
  }
} finally { clearInterval(heartbeat); db.close(); }
