import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { FakeDocs, memoryStore, emptyState } from './helpers.js';
import { parsePrompts, PROMPT_PREFIX, REPLY_PREFIX } from '../src/document.js';

function setup(text, answer = async () => 'answer') {
  const docs = new FakeDocs(text), store = memoryStore(), state = emptyState();
  const calls = [];
  const chat = { async answer(session, job, save) { calls.push(job.session); session.threadId ||= `thread-${job.session}`; await save(); return answer(session, job); } };
  return { docs, store, state, calls, engine: new Engine({ docs, store, state, chat, settleMs: 0 }) };
}
async function tick(engine) { await engine.poll(); await engine.worker; }

test('inserts under prompt and preserves all surrounding content, even when moved while thinking', async () => {
  const original = 'Before 🧭\n"{1} hello" suffix\nAfter café\n';
  let fixture;
  fixture = setup(original, async () => { fixture.docs.insert(1, 'Concurrent edit\n'); return 'Hello!'; });
  await tick(fixture.engine);
  assert.equal(fixture.docs.text, 'Concurrent edit\nBefore 🧭\n"{1} hello"\nHello!\n suffix\nAfter café\n');
  assert.equal(fixture.state.jobs[0].stage, 'done');
  for (const requests of fixture.docs.calls) for (const r of requests) {
    assert.ok(['insertText', 'createNamedRange', 'deleteNamedRange'].includes(Object.keys(r)[0]));
  }
});

test('same number reuses session, larger opens one, unknown smaller is ignored', async () => {
  const f = setup('"{5} first"\n');
  await tick(f.engine);
  for (const text of ['"{5} again"', '"{6} new"', '"{5} old session"', '"{3} invalid new"']) {
    f.docs.insert(f.docs.text.length, '\n' + text + '\n'); await tick(f.engine);
  }
  assert.deepEqual(f.calls, ['5', '5', '6', '5']);
  assert.equal(f.state.highestSession, '6');
  assert.equal(f.state.sessions['5'].threadId, 'thread-5');
  assert.equal(f.state.sessions['6'].threadId, 'thread-6');
});

test('identical submissions in separate places each receive exactly one reply', async () => {
  const f = setup('"{1} repeat"\n"{1} repeat"\n');
  await tick(f.engine); await tick(f.engine); await tick(f.engine);
  assert.equal(f.calls.length, 2);
  assert.equal(f.docs.text.match(/\nanswer\n/g).length, 2);
});

test('a lost reply write response is reconciled without duplicate AI turns or replies', async () => {
  let f;
  f = setup('"{1} hello"\n', async () => { f.docs.dropResponse = true; return 'once'; });
  await tick(f.engine);
  assert.equal(f.state.jobs[0].stage, 'ready');
  f.state.jobs[0].retryAt = 0;
  await tick(f.engine);
  assert.equal(f.calls.length, 1);
  assert.equal(f.docs.text.match(/once/g).length, 1);
  assert.equal(f.state.jobs[0].stage, 'done');
});

test('a lost claim response is recovered by its document marker', async () => {
  const f = setup('"{1} hello"\n'); f.docs.dropResponse = true;
  await assert.rejects(f.engine.poll(), /Connection lost/);
  assert.equal(f.state.jobs[0].stage, 'claiming');
  await tick(f.engine);
  assert.equal(f.state.jobs.length, 1);
  assert.equal(f.calls.length, 1);
});

test('an edited prompt is cancelled and surrounding text is never overwritten', async () => {
  let f;
  f = setup('before\n"{1} hello"\nafter\n', async () => { f.docs.insert(11, 'EDIT'); return 'answer'; });
  await tick(f.engine);
  assert.equal(f.state.jobs[0].stage, 'cancelled');
  assert.ok(!f.docs.text.includes('answer'));
  assert.match(f.docs.text, /before/); assert.match(f.docs.text, /after/);
});

test('revision conflict after generation retries insertion using fresh indices and cached answer', async () => {
  const f = setup('"{1} hello"\n');
  const batch = f.docs.batch.bind(f.docs); let inject = true;
  f.docs.batch = async (requests, revision) => {
    if (requests[0].insertText && inject) { inject = false; f.docs.insert(1, 'live edit\n'); }
    return batch(requests, revision);
  };
  await tick(f.engine);
  assert.equal(f.state.jobs[0].stage, 'ready'); f.state.jobs[0].retryAt = 0;
  await tick(f.engine);
  assert.equal(f.calls.length, 1);
  assert.equal(f.docs.text, 'live edit\n"{1} hello"\nanswer\n\n');
});

test('a fresh engine does not reprocess document markers after restart', async () => {
  const f = setup('"{1} hello"\n'); await tick(f.engine);
  const restarted = new Engine({ docs: f.docs, store: f.store, state: structuredClone(f.state), chat: { answer() { throw new Error('must not run'); } }, settleMs: 0 });
  await tick(restarted);
  assert.equal(parsePrompts(await f.docs.read(), '""').length, 0);
  assert.equal(Object.keys(f.docs.ranges).filter(n => n.startsWith(PROMPT_PREFIX)).length, 1);
  assert.equal(Object.keys(f.docs.ranges).filter(n => n.startsWith(REPLY_PREFIX)).length, 1);
});

test('typing a new prompt at the end of a reply survives named-range expansion', async () => {
  const f = setup('"{1} hello"\n'); await tick(f.engine);
  const reply = Object.values(f.docs.ranges).flatMap(g => g.namedRanges).find(n => n.name.startsWith(REPLY_PREFIX));
  f.docs.insert(reply.ranges[0].endIndex, '\n"{1} next"');
  await tick(f.engine);
  assert.equal(f.calls.length, 2);
});

test('pressing Enter after a submitted prompt during generation preserves the reply', async () => {
  let f;
  f = setup('"{1} hello"\n', async (_session, job) => { f.docs.insert(job.end, '\nNext paragraph'); return 'hello back'; });
  await tick(f.engine);
  assert.equal(f.state.jobs[0].stage, 'done');
  assert.equal(f.docs.text, '"{1} hello"\nhello back\n\nNext paragraph\n');
});

test('--once drains more than two pending prompts', async () => {
  const f = setup('"{1} one"\n"{1} two"\n"{2} three"\n"{2} four"\n');
  await f.engine.run({ once: true });
  assert.equal(f.calls.length, 4);
  assert.equal(f.state.jobs.filter(j => j.stage === 'done').length, 4);
});

test('a backing-off earlier prompt blocks later turns in the same session', async () => {
  const f = setup('"{1} hello"\n');
  f.state.jobs.push({ session: '1', stage: 'generating', retryAt: Date.now() + 60_000 });
  f.state.sessions['1'] = {}; f.state.highestSession = '1';
  await tick(f.engine);
  assert.equal(f.calls.length, 0);
});
