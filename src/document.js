export const PROMPT_PREFIX = 'docex.prompt.';
export const REPLY_PREFIX = 'docex.reply.';

export function parseDocumentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Provide a Google Docs URL: https://docs.google.com/document/d/ID/edit'); }
  const match = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !match) throw new Error('Expected an https://docs.google.com/document/d/ID URL.');
  return { id: match[1], tabId: url.searchParams.get('tab') || new URLSearchParams(url.hash.slice(1)).get('tab'), url: url.href };
}

// The connector flattens tabs; the native Docs API nests documentTab/childTabs.
export function documentTabs(doc) {
  const tabs = [];
  const walk = items => {
    for (const item of items || []) {
      const body = item.documentTab || item;
      const props = item.tabProperties || item;
      tabs.push({ ...body, id: props.tabId, title: props.title || 'Document' });
      walk(item.childTabs);
    }
  };
  walk(doc.tabs);
  if (!tabs.length && doc.body) tabs.push({ ...doc, id: undefined, title: doc.title });
  return tabs;
}

// Preserve UTF-16 indices. Gaps and nontext objects are barriers to prompt parsing.
export function textSegments(tab) {
  const segments = [];
  const walk = content => {
    let current;
    const barrier = () => { current = undefined; };
    for (const block of content || []) {
      if (block.paragraph) {
        for (const element of block.paragraph.elements || []) {
          const text = element.textRun?.content;
          const suggested = element.suggestedInsertionIds?.length || element.suggestedDeletionIds?.length;
          if (text === undefined || suggested) { barrier(); continue; }
          if (!current || current.end !== element.startIndex) {
            current = { start: element.startIndex, end: element.startIndex, text: '' };
            segments.push(current);
          }
          current.text += text;
          current.end = element.endIndex ?? element.startIndex + text.length;
        }
      } else {
        barrier();
        if (block.table) for (const row of block.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content);
        if (block.tableOfContents) walk(block.tableOfContents.content);
        barrier();
      }
    }
  };
  walk(tab.body?.content);
  return segments;
}

export function textAt(tab, start, end) {
  const segment = textSegments(tab).find(s => start >= s.start && end <= s.end);
  return segment?.text.slice(start - segment.start, end - segment.start);
}

export function namedRanges(tab) {
  const ranges = [];
  for (const [name, group] of Object.entries(tab.namedRanges || {})) {
    for (const named of group.namedRanges || []) {
      ranges.push({ name: named.name || name, id: named.namedRangeId, ranges: named.ranges || [] });
    }
  }
  return ranges;
}

export function findAnchor(doc, name) {
  for (const tab of documentTabs(doc)) {
    const entries = namedRanges(tab).filter(range => range.name === name);
    if (entries.length) return { tab, entries, ranges: entries.flatMap(e => e.ranges) };
  }
}

export function fullDocumentText(doc) {
  return documentTabs(doc).map(tab => {
    const sections = [`[${tab.title}]`, ...textSegments(tab).map(s => s.text)];
    for (const kind of ['headers', 'footers', 'footnotes']) {
      for (const [id, segment] of Object.entries(tab[kind] || {})) {
        sections.push(`[${kind}: ${id}]`, ...textSegments({ body: segment }).map(s => s.text));
      }
    }
    return sections.join('\n');
  }).join('\n\n');
}

export function validateDelimiters(chars) {
  const pair = Array.from(chars);
  if (pair.length !== 2 || pair.some(c => /[\s{}\d]/u.test(c))) throw new Error('--prompt-chars must contain exactly two non-whitespace delimiter characters (for example \'""\' or \'«»\').');
  return pair;
}

export function parsePrompts(doc, chars, tabId, jobs = []) {
  const [open, close] = validateDelimiters(chars);
  const pairs = [[open, close]];
  if (chars === '""') pairs.push(['“', '”']);
  if (chars === "''") pairs.push(['‘', '’']);
  const prompts = [];
  for (const tab of documentTabs(doc)) {
    if (tabId && tab.id !== tabId) continue;
    const excluded = namedRanges(tab).filter(r => r.name.startsWith(PROMPT_PREFIX) || r.name.startsWith(REPLY_PREFIX)).flatMap(named => {
      const isReply = named.name.startsWith(REPLY_PREFIX);
      const job = jobs.find(j => named.name === (isReply ? REPLY_PREFIX : PROMPT_PREFIX) + j.id);
      const original = job && (isReply ? cleanReply(job.answer || '') : job.raw);
      return named.ranges.map(r => {
        // Docs can grow a named range when typing at its boundary. Only mask the
        // original content when it is still identifiable; allow a new prompt after it.
        const current = textAt(tab, r.startIndex, r.endIndex);
        const offset = original && current?.indexOf(original);
        return typeof offset === 'number' && offset >= 0
          ? { startIndex: r.startIndex + offset, endIndex: r.startIndex + offset + original.length }
          : r;
      });
    });
    for (const segment of textSegments(tab)) {
      // Mask processed content before scanning, so quotes inside a reply cannot consume a later opener.
      let visible = segment.text;
      for (const range of excluded) {
        const from = Math.max(0, range.startIndex - segment.start);
        const to = Math.min(visible.length, range.endIndex - segment.start);
        if (from < to) visible = visible.slice(0, from) + '\0'.repeat(to - from) + visible.slice(to);
      }
      for (const [left, right] of pairs) {
        let cursor = 0;
        while (cursor < visible.length) {
          const from = visible.indexOf(left, cursor);
          if (from < 0) break;
          const to = visible.indexOf(right, from + left.length);
          if (to < 0) break;
          cursor = to + right.length;
          const inner = visible.slice(from + left.length, to);
          if (inner.includes('\0')) continue;
          const markers = [...inner.matchAll(/\{(\d+)\}/g)];
          if (markers.length !== 1) continue;
          const marker = markers[0];
          const session = BigInt(marker[1]).toString();
          const prompt = (inner.slice(0, marker.index) + inner.slice(marker.index + marker[0].length)).trim();
          if (!prompt) continue;
          prompts.push({ tabId: tab.id, start: segment.start + from, end: segment.start + cursor,
            raw: segment.text.slice(from, cursor), prompt, session });
        }
      }
    }
  }
  return prompts.sort((a, b) => (a.tabId || '').localeCompare(b.tabId || '') || a.start - b.start);
}

export function location(tabId, index) { return { index, ...(tabId ? { tabId } : {}) }; }
export function range(tabId, startIndex, endIndex) { return { startIndex, endIndex, ...(tabId ? { tabId } : {}) }; }

// Google strips these characters. Remove them before computing the reply range.
export function cleanReply(text) { return text.replace(/[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/g, '').trim(); }

export function resolvePromptAnchor(doc, job) {
  const anchor = findAnchor(doc, PROMPT_PREFIX + job.id);
  if (!anchor || anchor.ranges.length !== 1) throw new Error('The submitted prompt was removed or split; reply retained locally.');
  const r = anchor.ranges[0];
  const current = textAt(anchor.tab, r.startIndex, r.endIndex);
  const offset = current?.indexOf(job.raw) ?? -1;
  if (offset < 0 || current.indexOf(job.raw, offset + 1) >= 0) throw new Error('The submitted prompt was edited; reply retained locally.');
  // Typing a newline immediately after the closing delimiter can expand the
  // range. The original wrapped prompt still identifies the insertion boundary.
  return { ...anchor, start: r.startIndex + offset, end: r.startIndex + offset + job.raw.length };
}

export function replyRequests(doc, job, answer) {
  const anchor = resolvePromptAnchor(doc, job);
  const text = `\n${cleanReply(answer)}\n`;
  if (!text.trim()) throw new Error('Codex returned an empty answer.');
  return [
    { insertText: { location: location(anchor.tab.id, anchor.end), text } },
    ...anchor.entries.map(e => ({ deleteNamedRange: { namedRangeId: e.id, ...(anchor.tab.id ? { tabsCriteria: { tabIds: [anchor.tab.id] } } : {}) } })),
    { createNamedRange: { name: PROMPT_PREFIX + job.id, range: range(anchor.tab.id, anchor.start, anchor.end) } },
    { createNamedRange: { name: REPLY_PREFIX + job.id, range: range(anchor.tab.id, anchor.end + 1, anchor.end + text.length - 1) } },
  ];
}
