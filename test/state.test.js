import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.js';
import { emptyState } from './helpers.js';
import { options } from '../src/cli.js';

test('state persists in order, survives reload, and prevents two watchers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docex-state-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore('test', root); await store.acquire();
  t.after(() => store.release());
  const second = new StateStore('test', root);
  await assert.rejects(second.acquire(), /already watching/);
  const state = emptyState(); state.jobs.push({ id: '1', stage: 'generating', startAttempted: true });
  const firstWrite = store.save(state); state.highestSession = '9'; const secondWrite = store.save(state);
  await Promise.all([firstWrite, secondWrite]);
  const loaded = await store.load();
  assert.equal(loaded.highestSession, '9'); assert.ok(!loaded.jobs[0].startAttempted);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  await store.release(); await second.acquire(); await second.release();
});

test('CLI rejects malformed options before opening a connection', () => {
  const url = 'https://docs.google.com/document/d/abc/edit?tab=t.0';
  assert.equal(options([url, '--prompt-chars', '«»']).target.tabId, 't.0');
  assert.throws(() => options([url, '--interval', '0']));
  assert.throws(() => options([url, '--background', '--once']));
  assert.throws(() => options([url, 'extra']));
});
