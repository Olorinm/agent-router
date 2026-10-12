import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { CliWork } from '../src/matrix/cli-work.js';
import { ConnectorStore } from '../src/matrix/store.js';

const stores: ConnectorStore[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function setup() {
  const store = new ConnectorStore(':memory:', 'defer'); stores.push(store);
  return new CliWork(store, () => 'allow');
}
const request = (id: string, contextId = id) => SendMessageRequest.fromJSON({ message: {
  messageId: id, contextId, role: 'ROLE_USER', parts: [{ text: id }],
} });
const source = { sender: 'visitor:alice', room: 'channel:one', approved: true };
describe('deferred external work', () => {
  it('reopens persisted documents and deferred claims, then atomically stores a late attachment reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-upgrade-'));
    let store = new ConnectorStore(join(dir, 'work.sqlite'), 'defer');
    try {
      let work = new CliWork(store, () => 'allow');
      await work.send(request('persisted'), { ...source, documents: [{ name: 'body.txt', text: 'full input' }] });
      const claim = work.claim('instance')!;
      work.update(claim.claimId!, 'defer', 'Waiting', undefined, 'instance');
      store.close(); store = new ConnectorStore(join(dir, 'work.sqlite'), 'defer');
      work = new CliWork(store, () => 'allow');
      expect(work.inspect(claim.id)).toMatchObject({ deferred: true, documents: [{ name: 'body.txt', text: 'full input' }] });
      expect(work.claim('instance')).toBeNull();
      const files = [{ filename: 'result.txt', contentType: 'text/plain', content: Buffer.from('result').toString('base64') }];
      work.update(claim.claimId!, 'reply', 'Done', undefined, 'instance', files);
      store.close(); store = new ConnectorStore(join(dir, 'work.sqlite'), 'defer');
      work = new CliWork(store, () => 'allow');
      expect(work.outputAttachments(claim.id)).toEqual(files);
      expect(work.update(claim.claimId!, 'reply', 'Done', undefined, 'instance', files).status).toBe('completed');
      expect(() => work.update(claim.claimId!, 'reply', 'Done', undefined, 'other', files)).toThrow('claim_belongs_to_another_instance');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('lets one instance defer ten independent tasks and finish each through its original claim', async () => {
    const work = setup(), claims = [];
    for (let i = 0; i < 10; i++) await work.send(request(String(i)), { ...source, sender: `visitor:${i}` });
    for (let i = 0; i < 10; i++) {
      const claim = work.claim('instance', undefined, true)!; expect(claim).not.toBeNull(); claims.push(claim);
      work.update(claim.claimId!, 'defer', 'Waiting for external service', undefined, 'instance');
      expect((await work.get(claim.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    }
    expect(work.claim('instance')).toBeNull();
    for (const claim of claims.reverse()) {
      expect(() => work.update(claim.claimId!, 'reply', claim.id, undefined, 'another-instance')).toThrow('claim_belongs_to_another_instance');
      work.update(claim.claimId!, 'reply', claim.id, undefined, 'instance');
      expect(work.update(claim.claimId!, 'reply', claim.id, undefined, 'instance').status).toBe('completed');
    }
    expect(work.list()).toHaveLength(0);
  });
  it('blocks another task in the same context until deferred work completes', async () => {
    const work = setup(); await work.send(request('one', 'same'), source); await work.send(request('two', 'same'), source);
    const first = work.claim('instance', undefined, true)!; work.update(first.claimId!, 'defer', 'Waiting');
    expect(work.claim('instance')).toBeNull(); expect(work.claim('other')).toBeNull();
    work.update(first.claimId!, 'reply', 'done'); expect(work.claim('instance')?.id).not.toBe(first.id);
  });
  it('revokes stale background completion when new input arrives and handles cancellation', async () => {
    const work = setup(); await work.send(request('one'), source);
    const first = work.claim('instance')!; work.update(first.claimId!, 'defer', 'Waiting');
    const next = request('two', first.contextId); next.message!.taskId = first.id;
    await work.send(next, { ...source, documents: [{ name: 'new.txt', text: 'new input' }] });
    expect(() => work.update(first.claimId!, 'reply', 'old result')).toThrow('new_input_available_claim_again');
    const fresh = work.claim('instance')!; expect(fresh.claimId).not.toBe(first.claimId);
    expect(fresh.documents?.[0]?.text).toBe('new input');
    work.update(fresh.claimId!, 'defer', 'Waiting'); await work.cancel(fresh.id);
    expect(() => work.update(fresh.claimId!, 'reply', 'late')).toThrow('cancellation_requested');
    expect(work.update(fresh.claimId!, 'cancelled', '').status).toBe('canceled');
  });
});
