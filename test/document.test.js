import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDoc, FakeDocs } from './helpers.js';
import { parsePrompts, parseDocumentUrl, validateDelimiters, replyRequests, PROMPT_PREFIX, REPLY_PREFIX, fullDocumentText } from '../src/document.js';

test('parses custom delimiters, multiline text, marker anywhere, and UTF-16 offsets', () => {
  const text = '🧭 before\n«Hello\nworld {00012}» after\n';
  const [prompt] = parsePrompts(makeDoc(text), '«»');
  assert.equal(prompt.start, text.indexOf('«') + 1);
  assert.equal(prompt.end, text.indexOf('»') + 2);
  assert.equal(prompt.prompt, 'Hello\nworld');
  assert.equal(prompt.session, '12');
});

test('supports straight and smart quotes and big session integers', () => {
  const prompts = parsePrompts(makeDoc('"{1} first"\n“second {90071992547409999}”\n'), '""');
  assert.deepEqual(prompts.map(p => [p.session, p.prompt]), [['1', 'first'], ['90071992547409999', 'second']]);
});

test('ignores unfinished and ambiguous submissions', () => {
  for (const text of ['"unfinished {1}', '"missing marker"', '"{1} {2} ambiguous"', '"{1}   "']) {
    assert.deepEqual(parsePrompts(makeDoc(text), '""'), []);
  }
  assert.throws(() => validateDelimiters('abc'));
  assert.throws(() => validateDelimiters('{}'));
});

test('reads prompts split across styled runs without crossing objects or cells', () => {
  const doc = makeDoc('"{1} hello"\n');
  doc.tabs[0].body.content[0].paragraph.elements = [
    { startIndex: 1, endIndex: 6, textRun: { content: '"{1} ', textStyle: { bold: true } } },
    { startIndex: 6, endIndex: 13, textRun: { content: 'hello"\n' } },
  ];
  assert.equal(parsePrompts(doc, '""')[0].prompt, 'hello');
  doc.tabs[0].body.content[0].paragraph.elements.splice(1, 0, { startIndex: 6, endIndex: 7, inlineObjectElement: { inlineObjectId: 'image' } });
  assert.equal(parsePrompts(doc, '""').length, 0);
});

test('skips quoted output and still finds subsequent user prompts', async () => {
  const docs = new FakeDocs('"{1} first"\n');
  const [job] = parsePrompts(await docs.read(), '""'); job.id = 'job';
  await docs.batch([{ createNamedRange: { name: PROMPT_PREFIX + job.id, range: { startIndex: job.start, endIndex: job.end } } }], '1');
  await docs.batch(replyRequests(await docs.read(), job, 'Here is a quote " and "{2} do not run"'), String(docs.revision));
  docs.insert(docs.text.length, '\n"{1} next"');
  assert.deepEqual(parsePrompts(await docs.read(), '""').map(p => p.prompt), ['next']);
  assert.ok(docs.ranges[REPLY_PREFIX + job.id]);
});

test('scopes detection to URL tab but full read includes nested tabs', () => {
  const one = makeDoc('"{1} one"\n').tabs[0];
  const two = makeDoc('"{2} two"\n', 't.2').tabs[0];
  const doc = { tabs: [{ tabProperties: { tabId: one.tabId, title: one.title }, documentTab: one,
    childTabs: [{ tabProperties: { tabId: two.tabId, title: 'Second' }, documentTab: two }] }] };
  assert.deepEqual(parsePrompts(doc, '""', 't.2').map(p => p.session), ['2']);
  assert.match(fullDocumentText(doc), /Second/);
});

test('reads table cells independently and does not pair delimiters across cells', () => {
  const cell = (text, start) => ({ content: [{ paragraph: { elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text } }] } }] });
  const doc = { tabs: [{ tabId: 't.0', body: { content: [{ table: { tableRows: [{ tableCells: [
    cell('"{1} split\n', 4), cell('across cells"\n', 30), cell('"{2} valid cell"\n', 60),
  ] }] } }] } }] };
  assert.deepEqual(parsePrompts(doc, '""').map(p => p.prompt), ['valid cell']);
  assert.match(fullDocumentText(doc), /across cells/);
});

test('rejects unrelated URLs and accepts query or hash tab links', () => {
  assert.deepEqual(parseDocumentUrl('https://docs.google.com/document/d/abc/edit?tab=t.7').tabId, 't.7');
  assert.equal(parseDocumentUrl('https://docs.google.com/document/u/0/d/abc/edit#tab=t.8').tabId, 't.8');
  assert.throws(() => parseDocumentUrl('https://evil.example/document/d/abc'));
  assert.throws(() => parseDocumentUrl('http://docs.google.com/document/d/abc'));
});
