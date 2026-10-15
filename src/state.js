import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function stateRoot() { return process.env.DOCEX_STATE_DIR || join(homedir(), '.local', 'state', 'docex'); }

export class StateStore {
  constructor(documentId, root = stateRoot()) {
    this.directory = join(root, documentId);
    this.file = join(this.directory, 'state.json');
    this.lockFile = join(this.directory, 'lock.json');
    this.token = randomUUID();
    this.writes = Promise.resolve();
  }

  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token }));
        await handle.close();
        this.locked = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let lock;
        try { lock = JSON.parse(await readFile(this.lockFile, 'utf8')); }
        catch { throw new Error(`Cannot inspect ${this.lockFile}. Check for a running docex process before removing it.`); }
        try { process.kill(lock.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { await unlink(this.lockFile); continue; }
          throw error;
        }
        throw new Error(`docex is already watching this document (PID ${lock.pid}).`);
      }
    }
    throw new Error('Could not acquire the document lock.');
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 1 || !state.jobs || !state.sessions) throw new Error('Unsupported docex state format.');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, highestSession: null, sessions: {}, jobs: [] };
    }
  }

  save(state) {
    const contents = JSON.stringify(state, (key, value) => key === 'startAttempted' ? undefined : value, 2) + '\n';
    const write = async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.file);
    };
    this.writes = this.writes.catch(() => {}).then(write);
    return this.writes;
  }

  async release() {
    if (!this.locked) return;
    try {
      const lock = JSON.parse(await readFile(this.lockFile, 'utf8'));
      if (lock.token === this.token) await unlink(this.lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.locked = false;
  }
}
