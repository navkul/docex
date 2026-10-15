import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexChat } from '../src/chat.js';
import { makeDoc } from './helpers.js';

class FakeRpc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); this.calls = []; this.turns = []; }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { existing: { command: 'server' } } } };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/read') return { thread: { turns: this.turns, status: { type: 'idle' } } };
    if (method === 'turn/start') {
      const turn = { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'hello' }] };
      this.turns.push(turn); return { turn };
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

test('new session has only on-demand document access and reuses its thread', async () => {
  const rpc = new FakeRpc(); let reads = 0;
  const chat = new CodexChat(rpc, { async read() { reads++; return makeDoc('reference data\n'); } });
  const session = {}, save = async () => {};
  assert.equal(await chat.answer(session, { id: 'one', prompt: 'hi' }, save), 'hello');
  assert.equal(await chat.answer(session, { id: 'two', prompt: 'again' }, save), 'hello');
  assert.equal(reads, 0);
  assert.equal(rpc.calls.filter(c => c.method === 'thread/start').length, 1);
  const start = rpc.calls.find(c => c.method === 'thread/start').params;
  assert.equal(start.config['features.apps'], false);
  assert.equal(start.config['mcp_servers.existing.enabled'], false);
  assert.equal(start.dynamicTools[0].name, 'read_document');
  const result = await rpc.handlers.get('item/tool/call')({ tool: 'read_document', threadId: 'thread' });
  assert.equal(reads, 1); assert.match(result.contentItems[0].text, /reference data/);
});

test('restart recovers a completed turn without submitting it again', async () => {
  const rpc = new FakeRpc(); rpc.turns.push({ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'saved answer' }] });
  const chat = new CodexChat(rpc, {});
  const job = { id: 'job', clientId: 'job', turnId: 'old-turn' };
  assert.equal(await chat.answer({ threadId: 'thread' }, job, async () => {}), 'saved answer');
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 0);
});

test('uncertain start cannot silently duplicate a live request', async () => {
  const rpc = new FakeRpc(), chat = new CodexChat(rpc, {});
  await assert.rejects(chat.answer({ threadId: 'thread' }, { id: 'job', clientId: 'job', startAttempted: true }, async () => {}), /uncertain outcome/);
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 0);
});
