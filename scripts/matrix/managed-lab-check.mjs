import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory } from '@a2a-js/sdk/client';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';

const root = process.env.MATRIX_LAB_DIR ?? '/lab';
const ownerToken = (side) => readFileSync(`${root}/secrets-${side}/matrix`, 'utf8').trim();
const url = (side) => `http://agent-service-${side}:8790/_agent-router/v1`;
async function api(side, path, method = 'GET', body, token = ownerToken(side)) {
  const response = await fetch(url(side)+path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.ok, true, `${side} ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const a = await api('a', '/agents', 'POST', { name: 'managed-sender' });
const b = await api('b', '/agents', 'POST', { name: 'managed-receiver' });
const b2 = await api('b', '/agents', 'POST', { name: 'managed-sibling' });
assert.equal(b.owner, b2.owner); assert.notEqual(b.matrixId, b2.matrixId);
const gateway = (agent) => `/agents/${agent.id}/gateway`;
await api('b', gateway(b)+'/api/contacts', 'POST', { address: a.matrixId, note: 'Federated test peer', receive: 'allow', execution: 'allow' });
const instance1 = await api('b', `/agents/${b.id}/instances`, 'POST', { name: 'first' });
const instance2 = await api('b', `/agents/${b.id}/instances`, 'POST', { name: 'second' });
const fetchImpl = (input, init) => {
  const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${ownerToken('a')}`);
  return fetch(input, { ...init, headers, redirect: 'error' });
};
const client = await new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl }), transports: [new RestTransportFactory({ fetchImpl })] })
  .createFromUrl(url('a')+gateway(a)+`/agents/${encodeURIComponent(b.matrixId)}/`);
const sent = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'real AS federation' }] }, configuration: { returnImmediately: true } }));
assert.ok(sent.id);
let work;
const until = Date.now()+90_000;
while (Date.now()<until && !work) work = await api('b', gateway(b)+'/api/work/claim', 'POST', { worker: 'untrusted-name', wait: 2 }, instance1.token);
assert.ok(work, 'federated work arrived'); assert.equal(work.worker, instance1.instance.id); assert.equal(work.from, a.matrixId);
const second = await api('b', gateway(b)+'/api/work/claim', 'POST', { worker: 'same-name' }, instance2.token);
assert.equal(second, null);
const denied = await fetch(url('b')+gateway(b)+`/api/work/${work.claimId}/update`, { method: 'POST', headers: { Authorization: `Bearer ${instance2.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reply', text: 'forged' }) });
assert.equal(denied.status, 403);
await api('b', gateway(b)+`/api/work/${work.claimId}/update`, 'POST', { action: 'reply', text: 'AS-FEDERATION-OK' }, instance1.token);
let result;
while (Date.now()<until) {
  result = await client.getTask({ id: sent.id });
  if (result.status?.state === TaskState.TASK_STATE_COMPLETED) break;
  await new Promise((r) => setTimeout(r, 250));
}
assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
assert.match(JSON.stringify(result.artifacts), /AS-FEDERATION-OK/);
await api('b', `/agents/${b.id}/instances/${instance2.instance.id}`, 'DELETE');
const revoked = await fetch(url('b')+gateway(b)+'/api/status', { headers: { Authorization: `Bearer ${instance2.token}` } });
assert.equal(revoked.status, 401);
const evidence = { verifiedAt: new Date().toISOString(), sender: a, receiver: b, sibling: b2, taskId: sent.id,
  contextId: sent.contextId, receiverContextId: work.contextId, state: result.status.state,
  checks: ['distinct virtual users under one owner', 'real cross-homeserver AS delivery and reply', 'authenticated instance claim', 'no second claimant', 'stolen claim denied', 'revoked token denied'] };
writeFileSync(`${root}/managed-verification.json`, JSON.stringify(evidence, null, 2)+'\n');
process.stdout.write(JSON.stringify(evidence)+'\n');
