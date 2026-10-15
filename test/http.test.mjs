import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { FrameReader, frame } from '../src/ipc.mjs';

test('HTTP pairing, SSE, message routing, deduplication and access boundaries', { timeout: 25000 }, async () => {
  const base = resolve('.local'); mkdirSync(base, { recursive: true });
  const fixture = mkdtempSync(join(base, 'test-'));
  const id = randomUUID(), pipe = '\\\\.\\pipe\\remote-coding-test-' + randomUUID();
  const db = new DatabaseSync(join(fixture, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,model TEXT,
    archived INTEGER,agent_path TEXT,source TEXT,rollout_path TEXT)`);
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, '集成测试', '集成测试', fixture, 1, 'test', 0, null, 'vscode', ''); db.close();
  const history = new DatabaseSync(join(fixture, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_items (thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER)');
  history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(id, 'turn1', 1, 'u1', 'userMessage', JSON.stringify({ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '测试输入' }] }), 1700000000000); history.close();
  const sockets = new Set(); let starts = 0, answered = 0;
  const fakeServer = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const reader = new FrameReader(message => {
      if (message.type === 'request') {
        let result = {};
        if (message.method === 'initialize') result = { clientId: 'test-client' };
        if (message.method === 'thread-follower-start-turn') {
          starts++;
          assert.equal(message.version, 2);
          assert.equal(message.targetClientId, 'fake-desktop');
          assert.equal(message.params.turnStart.context.useUserMessageAdmission, false);
          assert.equal(message.params.turnStart.request.input[0].text, '发送测试');
          result = { result: { turn: { id: 'turn2' } } };
        }
        if (message.method === 'thread-follower-submit-user-input') {
          answered++; assert.equal(message.params.requestId, 'question'); assert.equal(message.params.response.answers.choice.answers[0], '选项一');
        }
        socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method, handledByClientId: 'fake-desktop', resultType: 'success', result }));
      } else if (message.method === 'thread-stream-following-changed' && message.params.following) {
        socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'fake-desktop', targetClientIds: ['test-client'],
          params: { conversationId: id, hostId: 'local', change: { type: 'snapshot', revision: 1, conversationState: {
            id, title: '集成测试', requests: [{ id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: '请选择', isOther: false, options: [{ label: '选项一' }] }] } }], threadRuntimeStatus: { type: 'idle' }, turns: [{ turnId: 'turn1', status: 'completed', items: [{ id: 'a1', type: 'agentMessage', text: '真实协议测试' }] }],
          } } } }));
      }
    });
    socket.on('data', chunk => reader.push(chunk));
  });
  await new Promise(resolve => fakeServer.listen(pipe, resolve));
  // A unique fixture port avoids interfering with the user's running prototype.
  const port = 33000 + Math.floor(Math.random() * 2000);
  let child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.mjs'], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, CODEX_HOME: fixture, REMOTE_CODING_PORT: String(port), REMOTE_CODING_IPC_PIPE: pipe, REMOTE_CODING_RUNTIME_DIR: fixture, REMOTE_CODING_EXPERIMENTAL_INTEGRATIONS: '1', REMOTE_CODING_DISABLE_DESKTOP_OPEN: '1', REMOTE_CODING_DISABLE_ACCOUNT_QUOTA: '1' },
    stdio: 'ignore',
  });
  const runtimePath = join(fixture, 'runtime.json');
  let eventController, channelChild;
  try {
    for (let tries = 0; tries < 80 && !existsSync(runtimePath); tries++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(runtimePath), 'fixture server must start');
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
    const url = `http://127.0.0.1:${runtime.port}`;
    let response = await fetch(url + '/api/threads'); assert.equal(response.status, 401);
    response = await fetch(url + '/api/local/status'); assert.equal(response.status, 403);
    response = await fetch(url + '/api/pair', { method: 'POST', headers: { Origin: 'http://evil.test' }, body: '{}' }); assert.equal(response.status, 403);
    response = await fetch(url + '/api/pair', { method: 'POST', body: JSON.stringify({ code: runtime.pairCode }) }); assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const status = await (await fetch(url + '/api/status', { headers: { Cookie: cookie } })).json();
    assert.equal((await fetch(url + '/api/quota')).status, 401);
    assert.equal((await fetch(url + '/api/quota', { headers: { Cookie: cookie } })).status, 503);
    assert.equal(status.features.openDesktop, false);
    response = await fetch(url + `/api/threads/${id}/open-desktop`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' }); assert.equal(response.status, 403);
    response = await fetch(url + `/api/threads/${id}/open-desktop`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': status.csrf }, body: '{}' }); assert.equal(response.status, 409);
    response = await fetch(url + `/api/threads/${id}/send`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' }); assert.equal(response.status, 403);
    const page = await (await fetch(url + `/api/threads/${id}/history`, { headers: { Cookie: cookie } })).json(); assert.equal(page.messages[0].text, '测试输入');
    eventController = new AbortController();
    response = await fetch(url + `/api/threads/${id}/events`, { headers: { Cookie: cookie }, signal: eventController.signal });
    const reader = response.body.getReader(); let text = '';
    while (!text.includes('snapshot')) { const chunk = await reader.read(); text += new TextDecoder().decode(chunk.value); }
    assert.match(text, /真实协议测试/);
    const input = () => fetch(url + `/api/threads/${id}/input`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': status.csrf }, body: JSON.stringify({ requestId: 'question', answers: { choice: '选项一' } }) });
    assert.equal((await input()).status, 200); assert.equal((await input()).status, 200); assert.equal(answered, 1);
    const messageId = randomUUID();
    const send = () => fetch(url + `/api/threads/${id}/send`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': status.csrf }, body: JSON.stringify({ text: '发送测试', messageId }) });
    assert.equal((await send()).status, 200); assert.equal((await send()).status, 200); assert.equal(starts, 1);
    // Test the actual MCP stdio channel without launching Claude or making a model request.
    channelChild = spawn(process.execPath, ['src/claude-channel.mjs'], { cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, REMOTE_CODING_RUNTIME_FILE: runtimePath }, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = [], channelRl = createInterface({ input: channelChild.stdout }); channelRl.on('line', line => lines.push(JSON.parse(line)));
    channelChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
    channelChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    let channel;
    for (let tries = 0; tries < 60 && !channel; tries++) { const list = await (await fetch(url + '/api/providers/claude/threads', { headers: { Cookie: cookie } })).json(); channel = list.threads[0]; if (!channel) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(channel); assert.ok(lines.find(m => m.id === 1)?.result.capabilities.experimental['claude/channel']);
    const channelMessageId = randomUUID();
    response = await fetch(url + `/api/providers/claude/threads/${channel.id}/send`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': status.csrf }, body: JSON.stringify({ text: '通道测试', messageId: channelMessageId }) });
    assert.equal(response.status, 200);
    for (let tries = 0; tries < 60 && !lines.some(m => m.method === 'notifications/claude/channel'); tries++) await new Promise(resolve => setTimeout(resolve, 50));
    const notification = lines.find(m => m.method === 'notifications/claude/channel'); assert.equal(notification.params.content, '通道测试');
    channelChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply', arguments: { message_id: channelMessageId, text: '收到通道消息' } } }) + '\n');
    for (let tries = 0; tries < 60 && !lines.some(m => m.id === 2); tries++) await new Promise(resolve => setTimeout(resolve, 50));
    const channelHistory = await (await fetch(url + `/api/providers/claude/threads/${channel.id}/history`, { headers: { Cookie: cookie } })).json();
    assert.equal(channelHistory.messages.at(-1).text, '收到通道消息'); channelRl.close();
    // Remembered phone cookies must survive an actual companion restart.
    response = await fetch(url + '/api/pair', { method: 'POST', body: JSON.stringify({ code: runtime.pairCode, remember: true }) });
    const rememberedCookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
    const firstStatus = await (await fetch(url + '/api/status', { headers: { Cookie: rememberedCookie } })).json();
    response = await fetch(url + '/api/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': status.csrf }, body: '{}' }); assert.equal(response.status, 200);
    response = await fetch(url + '/api/threads', { headers: { Cookie: cookie } }); assert.equal(response.status, 401);
    channelChild.stdin.end(); channelChild.kill(); channelChild = null;
    const exited = new Promise(resolve => child.once('exit', resolve));
    await fetch(url + '/api/local/exit', { method: 'POST', headers: { 'X-Local-Key': runtime.localKey }, body: '{}' }); await exited;
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.mjs'], { cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, CODEX_HOME: fixture, REMOTE_CODING_PORT: String(runtime.port), REMOTE_CODING_IPC_PIPE: pipe, REMOTE_CODING_RUNTIME_DIR: fixture, REMOTE_CODING_EXPERIMENTAL_INTEGRATIONS: '1', REMOTE_CODING_DISABLE_ACCOUNT_QUOTA: '1', REMOTE_CODING_DISABLE_DESKTOP_OPEN: '1' }, stdio: 'ignore' });
    for (let tries = 0; tries < 80 && !existsSync(runtimePath); tries++) await new Promise(resolve => setTimeout(resolve, 100));
    const restarted = JSON.parse(readFileSync(runtimePath, 'utf8'));
    response = await fetch(`http://127.0.0.1:${restarted.port}/api/status`, { headers: { Cookie: rememberedCookie } });
    assert.equal(response.status, 200); const restoredStatus = await response.json();
    assert.equal(restoredStatus.remembered, true); assert.notEqual(restoredStatus.csrf, firstStatus.csrf);
  } finally {
    channelChild?.stdin.end(); channelChild?.kill();
    eventController?.abort(); child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => fakeServer.close(resolve));
    assert.ok(resolve(fixture).startsWith(base + '\\'), 'cleanup must remain inside project .local');
    rmSync(fixture, { recursive: true, force: true });
  }
});
