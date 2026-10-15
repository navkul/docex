import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePrompts, documentTabs, PROMPT_PREFIX, REPLY_PREFIX, findAnchor, resolvePromptAnchor, range, replyRequests } from './document.js';
import { TurnFailure } from './chat.js';

export class Engine {
  constructor({ docs, chat, store, state, chars = '""', tabId, intervalMs = 2000, settleMs = 800, log = () => {}, signal }) {
    Object.assign(this, { docs, chat, store, state, chars, tabId, intervalMs, settleMs, log, signal });
    this.seen = new Map();
    this.warned = new Set();
  }

  save = () => this.store.save(this.state);

  async poll() {
    this.claimedThisPoll = false;
    const doc = await this.docs.read();
    if (this.tabId && !documentTabs(doc).some(tab => tab.id === this.tabId)) throw new Error(`Document tab ${this.tabId} does not exist.`);
    const candidates = parsePrompts(doc, this.chars, this.tabId, this.state.jobs);
    for (const job of this.state.jobs.filter(j => j.stage === 'claiming')) {
      const anchor = findAnchor(doc, PROMPT_PREFIX + job.id);
      if (anchor) { this.accept(job); await this.save(); }
      else if (!candidates.some(p => p.tabId === job.tabId && p.start === job.start && p.raw === job.raw)) {
        job.stage = 'cancelled'; job.lastError = 'Prompt changed before it could be submitted.'; await this.save();
      }
    }
    const current = new Set();
    for (const prompt of candidates) {
      const key = JSON.stringify([prompt.tabId, prompt.start, prompt.raw]);
      current.add(key);
      if (!this.seen.has(key)) this.seen.set(key, Date.now());
      if (Date.now() - this.seen.get(key) < this.settleMs) continue;
      // Retry a claim whose response was lost without allocating another job.
      const pending = this.state.jobs.find(job => job.stage === 'claiming' && job.tabId === prompt.tabId && job.start === prompt.start && job.raw === prompt.raw);
      const known = Object.hasOwn(this.state.sessions, prompt.session);
      if (!pending && !known && this.state.highestSession !== null && BigInt(prompt.session) <= BigInt(this.state.highestSession)) {
        if (!this.warned.has(key)) {
          this.log(`Ignored new session {${prompt.session}}: new session numbers must exceed {${this.state.highestSession}}. Existing session numbers can always be reused.`);
          this.warned.add(key);
        }
        continue;
      }
      const job = pending || { ...prompt, id: randomUUID(), stage: 'claiming', createdAt: new Date().toISOString() };
      if (!pending) { this.state.jobs.push(job); await this.save(); }
      await this.docs.batch([{ createNamedRange: { name: PROMPT_PREFIX + job.id, range: range(prompt.tabId, prompt.start, prompt.end) } }], doc.revisionId);
      // A fresh document is required after a mutation; one claim per poll keeps indices guarded.
      this.accept(job);
      this.claimedThisPoll = true;
      await this.save();
      this.log(`Queued prompt for session {${job.session}}.`);
      break;
    }
    for (const key of this.seen.keys()) if (!current.has(key)) this.seen.delete(key);
    this.kickWorker();
    return doc;
  }

  accept(job) {
    job.stage = 'queued';
    this.state.sessions[job.session] ||= {};
    if (this.state.highestSession === null || BigInt(job.session) > BigInt(this.state.highestSession)) this.state.highestSession = job.session;
  }

  kickWorker() {
    if (this.worker || this.signal?.aborted) return;
    const job = this.state.jobs.find((j, index) => ['queued', 'generating', 'ready'].includes(j.stage) &&
      (!j.retryAt || j.retryAt <= Date.now()) &&
      !this.state.jobs.slice(0, index).some(earlier => earlier.session === j.session && ['claiming', 'queued', 'generating', 'ready'].includes(earlier.stage)));
    if (!job) return;
    this.worker = this.process(job).catch(async error => {
      if (this.signal?.aborted) return;
      job.lastError = error.message;
      if (error instanceof TurnFailure) job.stage = 'error';
      else { job.failures = (job.failures || 0) + 1; job.retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(job.failures, 5)); }
      await this.save();
      this.log(`Session {${job.session}}: ${error.message}`);
    }).finally(() => { this.worker = null; });
  }

  async process(job) {
    let doc = await this.docs.read();
    if (findAnchor(doc, REPLY_PREFIX + job.id)) {
      job.stage = 'done'; await this.save(); return;
    }
    try { resolvePromptAnchor(doc, job); }
    catch {
      job.stage = 'cancelled'; job.lastError = 'Prompt was removed or edited. Submit a new wrapped prompt to ask again.';
      await this.save(); this.log(job.lastError); return;
    }
    if (!job.answer) {
      this.log(`Answering in session {${job.session}}.`);
      job.answer = await this.chat.answer(this.state.sessions[job.session], job, this.save);
      job.stage = 'ready'; await this.save();
    }
    // Re-read after generation: a user may have moved the prompt or edited surrounding text.
    doc = await this.docs.read();
    if (!findAnchor(doc, REPLY_PREFIX + job.id)) {
      let requests;
      try { requests = replyRequests(doc, job, job.answer); }
      catch (error) { job.stage = 'cancelled'; job.lastError = error.message; await this.save(); this.log(error.message); return; }
      await this.docs.batch(requests, doc.revisionId);
    }
    // The marker and reply are in one atomic batch. This also reconciles a lost write response.
    const verified = await this.docs.read();
    if (!findAnchor(verified, REPLY_PREFIX + job.id)) throw new Error('Reply write was not confirmed; waiting to reconcile.');
    job.stage = 'done'; job.completedAt = new Date().toISOString(); delete job.lastError; delete job.retryAt;
    await this.save();
    this.log(`Reply inserted for session {${job.session}}.`);
  }

  async run({ once = false } = {}) {
    let failures = 0;
    do {
      this.signal?.throwIfAborted();
      try { await this.poll(); failures = 0; }
      catch (error) {
        if (this.signal?.aborted) throw error;
        if (once) throw error;
        failures++;
        this.log(`Polling paused: ${error.message}`);
      }
      if (once) {
        // Keep discovering after each insert, because all later indices may have moved.
        do {
          await delay(this.settleMs + 10, undefined, { signal: this.signal });
          await this.poll();
          while (this.worker) { await this.worker; this.kickWorker(); }
        } while (this.claimedThisPoll);
        const pending = this.state.jobs.filter(j => !['done', 'cancelled'].includes(j.stage));
        if (pending.length) throw new Error(`${pending.length} prompt(s) remain pending or failed. Run again without --once; use --status for details.`);
        return;
      }
      await delay(Math.min(60_000, this.intervalMs * 2 ** Math.min(failures, 5)), undefined, { signal: this.signal });
    } while (!this.signal?.aborted);
  }

  async retryErrors() {
    for (const job of this.state.jobs.filter(j => j.stage === 'error')) {
      job.stage = 'queued'; job.clientId = randomUUID(); delete job.turnId; delete job.startAttempted; delete job.lastError;
    }
    await this.save();
  }
}
