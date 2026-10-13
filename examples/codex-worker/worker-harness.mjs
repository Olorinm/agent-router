import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('worker reports model connection failures without leaking diagnostics, and preserves successful recovery', async () => {
  for (const recovers of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'router-worker-status-'));
    const fixture = join(root, 'fixture.json');
    const router = join(root, 'router.cjs');
    const codex = join(root, 'codex.cjs');
    writeFileSync(fixture, JSON.stringify({ progress: [] }));
    writeFileSync(router, `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.WORKER_TEST_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [command, ...args] = process.argv.slice(2);
let result = {};
if (command === 'claim') {
  result = state.claimed ? null : { claimId: 'claim-1', id: 'task-1', contextId: 'context-1', from: 'visitor:test', execution: { accessMode: 'read-only' }, input: { parts: [{ text: 'test request' }] } };
  state.claimed = true;
}
if (command === 'progress') state.progress.push(args[1]);
if (command === 'work') result = { cancelRequested: false, newInput: false };
if (['reply', 'fail', 'cancelled'].includes(command)) state.result = { action: command, text: fs.readFileSync(0, 'utf8') };
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
    writeFileSync(codex, `#!${process.execPath}
require('node:assert/strict').equal(process.argv[process.argv.indexOf('--sandbox') + 1], 'read-only');
require('node:assert/strict').equal(process.argv.includes('use_legacy_landlock'), ${recovers});
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const assert = require('node:assert/strict');
assert.equal(process.env.LARKSUITE_CLI_CONFIG_DIR, ${recovers} ? ${JSON.stringify(join(root, 'lark', 'config'))} : undefined);
assert.equal(process.env.LARKSUITE_CLI_DATA_DIR, ${recovers} ? ${JSON.stringify(join(root, 'lark', 'data'))} : undefined);
assert.equal(process.env.LARKSUITE_CLI_APP_SECRET, undefined);
assert.equal(process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN, undefined);
assert.equal(process.env.CONNECTOR_API_TOKEN, undefined);
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  assert.equal(prompt.includes('lark-cli skills read lark-shared'), ${recovers});
  assert.equal(prompt.includes('lark-cli skills read lark-im'), ${recovers});
});
emit({ type: 'thread.started', thread_id: 'native-session-1' });
emit({ type: 'turn.started' });
emit({ type: 'error', message: 'Reconnecting... tls handshake eof PRIVATE_OPERATOR_DETAIL' });
emit({ type: 'error', message: 'Reconnecting... tls handshake eof PRIVATE_OPERATOR_DETAIL' });
setTimeout(() => {
  if (${recovers}) {
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered answer' } });
    emit({ type: 'turn.completed' });
  } else emit({ type: 'turn.failed', error: { message: 'tls handshake eof PRIVATE_OPERATOR_DETAIL' } });
  process.exit(${recovers ? 0 : 1});
}, 200);
`, { mode: 0o755 });
    let logs = '';
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      env: {
        ...process.env,
        AGENT_ROUTER_BIN: router,
        CODEX_BIN: codex,
        CODEX_CONTAINER_ISOLATION: '0',
        CODEX_USE_LEGACY_LANDLOCK: recovers ? '1' : '0',
        WORKER_STATE_DIR: join(root, 'state'),
        WORKER_WORKSPACE_DIR: join(root, 'workspaces'),
        WORKER_TEST_FIXTURE: fixture,
        WORKER_LARK_DIR: recovers ? join(root, 'lark') : '',
        LARKSUITE_CLI_APP_SECRET: 'PRIVATE_LARK_SECRET',
        LARKSUITE_CLI_USER_ACCESS_TOKEN: 'PRIVATE_LARK_TOKEN',
        CONNECTOR_API_TOKEN: 'PRIVATE_GATEWAY_TOKEN',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { logs += b; });
    child.stderr.on('data', b => { logs += b; });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      let result;
      for (let attempt = 0; attempt < 150; attempt++) {
        try { result = JSON.parse(readFileSync(fixture, 'utf8')); } catch { /* The fixture writer may be between writes. */ }
        if (result?.result) break;
        await delay(50);
      }
      assert.ok(result?.result, logs);
      assert.equal(result.progress.includes('远程 Codex 已接收，正在处理。'), false);
      assert.equal(result.progress.filter(text => text === '远端模型连接中断，正在重试。').length, 1);
      assert.equal(result.result.action, recovers ? 'reply' : 'fail');
      assert.equal(result.result.text, recovers ? 'recovered answer' : '远端模型连接失败，本次执行已停止；会话已保留，可稍后继续。');
      if (recovers) assert.ok(result.progress.includes('远端模型连接已恢复，正在处理。'));
      assert.equal(JSON.stringify(result).includes('PRIVATE_OPERATOR_DETAIL'), false);
      assert.equal(logs.includes('PRIVATE_OPERATOR_DETAIL'), false);
      assert.ok(logs.includes('codex.connection_retry'));
    } finally {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      await closed;
      clearTimeout(force);
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  }
});
