import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class RpcError extends Error {
  constructor(message, data) { super(message); this.name = 'RpcError'; this.data = data; }
}

// One private stdio connection. No browser or AI window is opened.
export class AppServer extends EventEmitter {
  constructor({ binary = 'codex', timeoutMs = 60_000 } = {}) {
    super();
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.handlers = new Map();
    this.closed = false;
  }

  async start() {
    this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.stderr.on('data', () => {}); // Server logs may include private prompt text.
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(new Error(`Cannot start Codex: ${error.message}. Install Codex CLI and run codex login.`)));
    this.child.once('exit', (code, signal) => this.fail(new Error(`Codex app server exited (${signal || code}). Restart docex to resume.`)));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.emit('diagnostic', error.message); }
    });
    const info = await this.call('initialize', {
      clientInfo: { name: 'docex', title: 'docex', version: '0.1.0' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    this.send({ method: 'initialized', params: {} });
    return info;
  }

  send(message) {
    if (this.closed) throw new Error('Codex connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.sequence++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out; its outcome must be reconciled before retrying.`, { timeout: true, method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.message, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      const handler = this.handlers.get(message.method);
      Promise.resolve().then(() => {
        if (!handler) throw new Error(`docex does not support interactive request ${message.method}`);
        return handler(message.params);
      }).then(result => this.send({ id: message.id, result }), error => {
        if (!this.closed) this.send({ id: message.id, error: { code: -32601, message: error.message } });
      }).catch(() => {});
      return;
    }
    this.emit('notification', message.method, message.params);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  close() {
    this.fail(new Error('docex stopped.'));
    this.lines?.close();
    this.child?.stdin.destroy();
    this.child?.kill('SIGTERM');
  }
}
