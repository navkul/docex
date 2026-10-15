// Live integration test. Appends a small transcript to the supplied test document.
// Usage: npm run smoke -- 'https://docs.google.com/document/d/ID/edit?tab=t.0'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../src/rpc.js';
import { GoogleDocs } from '../src/docs.js';
import { StateStore } from '../src/state.js';
import { parseDocumentUrl, documentTabs, textSegments, findAnchor, textAt, REPLY_PREFIX } from '../src/document.js';

const target = parseDocumentUrl(process.argv[2]);
const store = new StateStore(target.id);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const rpc = new AppServer();
let watcher, watcherDone, logs = '', tabId;
const checks = [];
const check = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const state = () => store.load();

async function waitFor(predicate, label, timeout = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (watcher?.exitCode !== null && watcher?.exitCode !== undefined) throw new Error(`Watcher stopped during ${label}: ${logs}`);
    const result = await predicate();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}. Watcher log: ${logs}`);
}

async function startWatcher() {
  watcher = spawn(process.execPath, [cli, target.url, '--prompt-chars', '«»', '--interval', '1'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  watcher.stdout.on('data', data => { logs += data; }); watcher.stderr.on('data', data => { logs += data; });
  watcherDone = new Promise(resolve => watcher.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Watcher startup timed out.')), 60_000);
    watcher.once('message', message => { if (message.ready) { clearTimeout(timer); resolve(); } });
    watcher.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
}

async function stopWatcher() {
  if (!watcher || watcher.exitCode !== null) return;
  watcher.kill('SIGTERM'); await watcherDone; watcher = undefined;
}

let docs;
async function append(text) {
  // A marker may be claimed while the test writes. Retry only an explicitly rejected revision.
  for (let i = 0; i < 8; i++) {
    const doc = await docs.read();
    const tab = documentTabs(doc).find(t => t.id === tabId);
    try {
      await docs.batch([{ insertText: { location: { tabId, index: tab.body.content.at(-1).endIndex - 1 }, text } }], doc.revisionId);
      return;
    } catch (error) { if (!/revision/i.test(error.message) || i === 7) throw error; }
  }
}

async function waitAnswer(prompt) {
  const job = await waitFor(async () => {
    const job = (await state()).jobs.find(j => j.prompt === prompt);
    if (job && ['error', 'cancelled'].includes(job.stage)) throw new Error(job.lastError);
    return job?.stage === 'done' && job;
  }, 'reply');
  const doc = await docs.read();
  const anchor = findAnchor(doc, REPLY_PREFIX + job.id);
  assert.ok(anchor, 'reply marker exists in Google Docs');
  assert.equal(anchor.ranges.length, 1);
  assert.equal(textAt(anchor.tab, anchor.ranges[0].startIndex, anchor.ranges[0].endIndex).trim(), job.answer.trim());
  return job;
}

try {
  // A live process, rather than the existence of a lock file, is the stopping condition.
  try {
    const lock = JSON.parse(await readFile(store.lockFile, 'utf8'));
    try { process.kill(lock.pid, 0); throw new Error('Stop the existing watcher with docex URL --stop before running the smoke test.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rpc.start();
  docs = new GoogleDocs(rpc, target.id, cwd); await docs.connect();
  const before = await docs.read(); tabId = target.tabId || documentTabs(before)[0].id;
  const originalTab = documentTabs(before).find(t => t.id === tabId);
  const originalText = textSegments(originalTab).map(s => s.text).join('');
  const originalElements = originalTab.body.content.flatMap(b => b.paragraph?.elements || []).filter(e => e.textRun?.content.trim()).map(e => ({ text: e.textRun.content, style: e.textRun.textStyle }));
  const initial = await state();
  const first = String(BigInt(initial.highestSession || '0') + 1n), second = String(BigInt(first) + 1n);
  const nonce = Date.now().toString(36);
  const codeword = `cedar-${nonce}`, key = `harbor-${nonce}`;
  const prompt1 = `Remember ${codeword} as my codeword in this conversation. Reply only: remembered.`;
  await startWatcher();
  await append(`\nLive integration test ${nonce}\nReference parcel key: ${key}.\n\n«{${first}} ${prompt1}`);
  await delay(4500);
  assert.equal((await state()).jobs.length, initial.jobs.length);
  check('incomplete prompt is not submitted');
  await append('»\n\n');
  await waitFor(async () => (await state()).jobs.find(j => j.prompt === prompt1 && j.stage === 'generating'), 'generation');
  const moved = await docs.read();
  const livePrefix = `Concurrent edit ${nonce}: preserved.\n`;
  await docs.batch([{ insertText: { location: { tabId, index: 1 }, text: livePrefix } }], moved.revisionId);
  const firstAnswer = await waitAnswer(prompt1);
  assert.match(firstAnswer.answer, /remembered/i);
  check('custom delimiters and reply placement survive a concurrent edit');

  await stopWatcher(); await startWatcher();
  const prompt2 = 'What was my codeword? Reply only the codeword. Do not read the document.';
  await append(`«${prompt2} {${first}}»\n\n`);
  const followup = await waitAnswer(prompt2); assert.equal(followup.answer.trim(), codeword);
  check('same numbered session remembers across watcher restart');

  const prompt3 = `In this new conversation, have I given you a codeword? Do not read the document. Reply only UNKNOWN if none. Test ${nonce}.`;
  await append(`«{${second}} ${prompt3}»\n\n`);
  const isolated = await waitAnswer(prompt3); assert.match(isolated.answer, /^UNKNOWN[.!]?$/i);
  check('larger session number starts an independent conversation');

  const prompt4 = `Read this document and give the reference parcel key from Live integration test ${nonce}. Reply only the key.`;
  await append(`«{${first}} ${prompt4}»\n\n`);
  const context = await waitAnswer(prompt4); assert.equal(context.answer.trim(), key);
  check('document context is available on request');

  const final = await docs.read();
  const finalTab = documentTabs(final).find(t => t.id === tabId);
  const finalText = textSegments(finalTab).map(s => s.text).join('');
  assert.ok(finalText.startsWith(livePrefix + originalText.slice(0, -1)));
  const elements = finalTab.body.content.flatMap(b => b.paragraph?.elements || []);
  for (const original of originalElements) {
    const element = elements.find(e => e.textRun?.content === original.text);
    assert.ok(element, `Existing text retained: ${original.text.slice(0, 50)}`);
    assert.deepEqual(element.textRun.textStyle, original.style);
  }
  check('pre-existing text and character formatting remain intact');
  await delay(3500);
  assert.equal((await state()).jobs.length, initial.jobs.length + 4);
  check('repeated polling does not duplicate submissions');
  await mkdir(join(cwd, 'artifacts'), { recursive: true });
  const report = { date: new Date().toISOString(), document: target.url, checks, sessions: [first, second], answers: [firstAnswer, followup, isolated, context].map(j => ({ session: j.session, prompt: j.prompt, answer: j.answer, stage: j.stage })) };
  await writeFile(join(cwd, 'artifacts', 'live-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('All live checks passed. Transcript retained in the test document. Report: artifacts/live-smoke.json');
} finally { await stopWatcher(); rpc.close(); }
