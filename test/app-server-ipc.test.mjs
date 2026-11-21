import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServerIpc, localAppServerUrl } from '../src/app-server-ipc.mjs';
import { Bridge } from '../src/bridge.mjs';

test('shared App Server preserves the thread, streams updates, and scopes controls to the active turn', async () => {
  const id = 'fixture-thread';
  let online = false;
  const sent = [];
  class Socket extends EventTarget {
    readyState = 1;
    receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      const thread = { id, name: 'Fixture', status: { type: online ? 'idle' : 'notLoaded' } };
      const replies = {
        'thread/read': { thread },
        'thread/resume': { thread, model: 'fixture-model', reasoningEffort: 'high', serviceTier: null },
        'thread/turns/list': { data: [{ id: 'old-turn', status: 'completed', items: [
          { id: 'old-item', type: 'agentMessage', text: 'Existing reply' },
        ] }] },
        'turn/start': { turn: { id: 'next-turn' } },
      };
      if (request.method && request.id) queueMicrotask(() => this.receive({ id: request.id, result: replies[request.method] || {} }));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const socket = new Socket();
  const ipc = new AppServerIpc({ url: 'ws://127.0.0.1:3211', connectSocket: () => socket });
  const bridge = new Bridge(ipc, { get: key => key === id, messageTimes: () => [] });
  try {
    const linked = once(ipc, 'connected');
    ipc.connect(); socket.dispatchEvent(new Event('open')); await linked;
    assert.equal(await ipc.owner(id), null);
    assert.equal(sent.some(m => m.method === 'thread/resume'), false);
    online = true;
    let resolveSnapshot;
    const snapshot = new Promise(resolve => { resolveSnapshot = resolve; });
    await bridge.subscribe(id, event => { if (event.type === 'snapshot') resolveSnapshot(event); });
    const view = await snapshot;
    assert.equal(view.id, id);
    assert.equal(view.writable, true);
    assert.equal(view.messages[0].text, 'Existing reply');
    assert.equal((await bridge.send(id, 'Fixture input', 'fixture-message')).accepted, true);
    const notify = (method, params, wireId) => socket.receive({ id: wireId, method, params: { threadId: id, ...params } });
    notify('turn/started', { turn: { id: 'next-turn', status: 'inProgress', items: [] } });
    notify('item/agentMessage/delta', { turnId: 'next-turn', itemId: 'reply', delta: 'New ' });
    notify('item/agentMessage/delta', { turnId: 'next-turn', itemId: 'reply', delta: 'reply' });
    assert.equal(bridge.view(bridge.threads.get(id)).messages.at(-1).text, 'New reply');
    await bridge.send(id, 'Fixture guidance', 'fixture-guidance', { mode: 'steer' });
    notify('item/commandExecution/requestApproval', { turnId: 'next-turn', command: 'fixture command' }, 0);
    await bridge.respond(id, 'app-server:0', 'decline');
    await bridge.stop(id);
    assert.equal(sent.find(m => m.method === 'turn/start').params.threadId, id);
    assert.equal(sent.find(m => m.method === 'turn/steer').params.expectedTurnId, 'next-turn');
    assert.deepEqual(sent.find(m => m.id === 0), { id: 0, result: { decision: 'decline' } });
    assert.deepEqual(sent.find(m => m.method === 'turn/interrupt').params, { threadId: id, turnId: 'next-turn' });
  } finally { bridge.close(); }
});

test('shared endpoint accepts only explicit loopback WebSockets', () => {
  assert.equal(localAppServerUrl('ws://[::1]:3211/rpc'), 'ws://[::1]:3211/rpc');
  for (const url of ['http://127.0.0.1:3211', 'ws://192.0.2.9:3211', 'ws://127.0.0.1', 'ws://user@127.0.0.1:3211']) {
    assert.throws(() => localAppServerUrl(url), /回环/);
  }
});
