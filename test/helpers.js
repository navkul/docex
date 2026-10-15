import { randomUUID } from 'node:crypto';

export function makeDoc(text, tabId = 't.0') {
  let index = 1;
  const content = text.split(/(?<=\n)/).filter(Boolean).map(value => {
    const startIndex = index; index += value.length;
    return { startIndex, endIndex: index, paragraph: { elements: [{ startIndex, endIndex: index, textRun: { content: value, textStyle: {} } }] } };
  });
  return { documentId: 'test-doc', revisionId: '1', tabs: [{ tabId, title: 'Test', body: { content }, namedRanges: {} }] };
}

export class FakeDocs {
  constructor(text) { this.text = text; this.revision = 1; this.ranges = {}; this.calls = []; }
  async read() {
    const doc = makeDoc(this.text);
    doc.revisionId = String(this.revision);
    doc.tabs[0].namedRanges = structuredClone(this.ranges);
    return doc;
  }
  insert(index, text) {
    this.text = this.text.slice(0, index - 1) + text + this.text.slice(index - 1);
    for (const group of Object.values(this.ranges)) for (const named of group.namedRanges) for (const r of named.ranges) {
      if (r.startIndex >= index) r.startIndex += text.length;
      if (r.endIndex >= index) r.endIndex += text.length;
    }
    this.revision++;
  }
  async batch(requests, revisionId) {
    if (String(this.revision) !== revisionId) throw new Error('Revision conflict');
    this.calls.push(structuredClone(requests));
    for (const request of requests) {
      if (request.insertText) this.insert(request.insertText.location.index, request.insertText.text);
      else if (request.createNamedRange) {
        const { name, range } = request.createNamedRange;
        const group = this.ranges[name] ||= { namedRanges: [] };
        group.namedRanges.push({ name, namedRangeId: randomUUID(), ranges: [structuredClone(range)] });
      } else if (request.deleteNamedRange) {
        for (const [name, group] of Object.entries(this.ranges)) {
          group.namedRanges = group.namedRanges.filter(r => r.namedRangeId !== request.deleteNamedRange.namedRangeId);
          if (!group.namedRanges.length) delete this.ranges[name];
        }
      } else throw new Error('Unexpected mutation');
    }
    this.revision++;
    if (this.dropResponse) { this.dropResponse = false; throw new Error('Connection lost after commit'); }
    return {};
  }
}

export function memoryStore() {
  return { saves: [], async save(state) { this.saves.push(structuredClone(state)); } };
}

export function emptyState() { return { version: 1, highestSession: null, sessions: {}, jobs: [] }; }
