#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AppServer } from './rpc.js';
import { GoogleDocs } from './docs.js';
import { CodexChat } from './chat.js';
import { Engine } from './engine.js';
import { StateStore, stateRoot } from './state.js';
import { parseDocumentUrl, validateDelimiters, documentTabs } from './document.js';

const HELP = `docex — chat with Codex through a Google document

Usage: docex <google-doc-url> [options]

  --prompt-chars <pair>  Opening and closing characters (default: '""')
  --interval <seconds>  Poll interval, minimum 1 second (default: 2)
  --all-tabs            Watch all tabs (default: URL tab, otherwise first tab)
  --model <name>        Use a specific Codex model (default: your Codex model)
  --effort <level>      Reasoning effort: minimal, low, medium, high, xhigh, max, ultra
  --background         Detach and leave only your Google Doc visible
  --status             Show watcher status and pending jobs
  --stop               Stop the watcher for this document
  --once               Process currently submitted prompts, then exit
  --retry-errors       Retry AI turns that failed or were interrupted
  --state-dir <path>    State directory (default: ~/.local/state/docex)
  --codex <path>        Codex executable (default: codex)
  --help               Show this help

Example:
  docex 'https://docs.google.com/document/d/ID/edit' --prompt-chars '""' --background

Write "{1} Hi, what is your name?" in the document. Reuse {1} to continue.
Use a new larger number, such as {2}, to start a separate conversation.
Only complete, wrapped prompts are submitted. Replies appear directly below.
Requires Node 22+, Codex CLI signed in, and Google Drive connected to Codex.
`;

export function options(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'prompt-chars': { type: 'string', default: '""' }, interval: { type: 'string', default: '2' },
    'all-tabs': { type: 'boolean' }, model: { type: 'string' }, effort: { type: 'string' },
    background: { type: 'boolean' }, status: { type: 'boolean' }, stop: { type: 'boolean' },
    once: { type: 'boolean' }, 'retry-errors': { type: 'boolean' },
    'state-dir': { type: 'string' }, codex: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error('Provide exactly one Google Doc URL. Run docex --help for examples.');
  validateDelimiters(values['prompt-chars']);
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 1) throw new Error('--interval must be at least 1 second.');
  if (values.effort && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(values.effort)) throw new Error('Invalid --effort. See docex --help.');
  if ([values.status, values.stop, values.once, values.background].filter(Boolean).length > 1) throw new Error('Use only one of --background, --once, --status, and --stop.');
  return { ...values, target: parseDocumentUrl(positionals[0]), intervalMs: interval * 1000 };
}

async function watcherPid(store) {
  try {
    const lock = JSON.parse(await readFile(store.lockFile, 'utf8'));
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) { console.log(HELP); return; }
  const store = new StateStore(opts.target.id, resolve(opts['state-dir'] || stateRoot()));
  if (opts.status || opts.stop) {
    const pid = await watcherPid(store);
    if (opts.stop) {
      if (pid) { process.kill(pid, 'SIGTERM'); console.log(`Stopping docex (PID ${pid}).`); }
      else console.log('No running watcher for this document.');
    } else {
      const state = await store.load();
      console.log(pid ? `Watching (PID ${pid}).` : 'Stopped.');
      console.log(`${Object.keys(state.sessions).length} sessions; ${state.jobs.filter(j => j.stage === 'done').length} replies; ${state.jobs.filter(j => !['done', 'cancelled'].includes(j.stage)).length} pending/error prompts.`);
      for (const job of state.jobs.filter(j => j.lastError)) console.log(`{${job.session}} ${job.stage}: ${job.lastError}`);
      console.log(`State: ${store.directory}`);
    }
    return;
  }
  if (opts.background) {
    if (await watcherPid(store)) throw new Error('docex is already watching this document.');
    await mkdir(store.directory, { recursive: true, mode: 0o700 });
    const logFile = join(store.directory, 'watcher.log');
    const log = await open(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter(a => a !== '--background')], {
      detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], windowsHide: true,
    });
    await log.close();
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Startup timed out. See ${logFile}`)); }, 90_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Watcher exited (${code}). See ${logFile}`)); });
      child.once('message', message => { if (message.ready) { clearTimeout(timeout); resolveReady(); } });
    });
    child.disconnect(); child.unref();
    console.log(`docex is watching in the background (PID ${child.pid}).\nLog: ${logFile}\nStop: docex '${opts.target.url}' --stop`);
    return;
  }
  await store.acquire();
  const rpc = new AppServer({ binary: opts.codex || 'codex' });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  rpc.on('disconnect', error => { if (!abort.signal.aborted) { console.error(error.message); abort.abort(error); } });
  const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
  let engine;
  try {
    const state = await store.load();
    const cwd = join(store.directory, 'workspace');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await rpc.start();
    const docs = new GoogleDocs(rpc, opts.target.id, cwd);
    await docs.connect();
    const doc = await docs.read();
    const tabId = opts['all-tabs'] ? undefined : opts.target.tabId || documentTabs(doc)[0]?.id;
    if (tabId && !documentTabs(doc).some(t => t.id === tabId)) throw new Error(`Document tab ${tabId} does not exist.`);
    const chat = new CodexChat(rpc, docs, { cwd, model: opts.model, effort: opts.effort, log, signal: abort.signal });
    engine = new Engine({ docs, chat, store, state, chars: opts['prompt-chars'], tabId, intervalMs: opts.intervalMs, log, signal: abort.signal });
    if (opts['retry-errors']) await engine.retryErrors();
    log(`Watching ${doc.title}. Delimiters: ${opts['prompt-chars']}. Press Ctrl+C to stop.`);
    process.send?.({ ready: true });
    await engine.run({ once: opts.once });
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    abort.abort(); rpc.close();
    await engine?.worker?.catch(() => {});
    await store.release();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`docex: ${error.message}`); process.exitCode = 1; });
}
