import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, frame } from '../src/ipc.mjs';
import { applyPatches, publicConversation, visibleUserText, messageFromItem } from '../src/state.mjs';
import { Bridge } from '../src/bridge.mjs';
import { EventEmitter } from 'node:events';

function conversation({ busy = false } = {}) {
  return { id: 'test', title: '测试', latestModel: 'test-model', threadRuntimeStatus: { type: busy ? 'active' : 'idle' }, requests: [],
    turns: [{ turnId: 'turn-1', status: busy ? 'inProgress' : 'completed', items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
      { id: 'a1', type: 'agentMessage', text: '你好，世界', phase: 'final_answer' },
      { id: 'c1', type: 'commandExecution', aggregatedOutput: 'private-token' },
      { id: 'r1', type: 'reasoning', content: 'private-reasoning' },
    ] }] };
}

test('IPC handles fragmented unicode frames and consecutive messages', () => {
  const seen = []; const reader = new FrameReader(m => seen.push(m));
  const first = { text: '中文消息 🚀' }, second = { type: 'response' };
  const buffer = Buffer.concat([frame(first), frame(second)]);
  for (let i = 0; i < buffer.length; i++) reader.push(buffer.subarray(i, i + 1));
  assert.deepEqual(seen, [first, second]);
});
test('IPC rejects an oversized announced frame', () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(99999);
  assert.throws(() => new FrameReader(() => {}, 1024).push(header));
});
test('patches preserve array insertion, removal and incremental message text', () => {
  const state = { items: [{ text: 'a' }, { text: 'b' }] };
  applyPatches(state, [{ op: 'replace', path: ['items', 0, 'text'], value: '中文' },
    { op: 'add', path: ['items', 1], value: { text: 'new' } }, { op: 'remove', path: ['items', 2] }]);
  assert.deepEqual(state.items, [{ text: '中文' }, { text: 'new' }]);
});
test('patches reject prototype pollution', () => {
  assert.throws(() => applyPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]));
  assert.equal({}.polluted, undefined);
});
test('phone projection excludes tool output and reasoning', () => {
  const publicState = publicConversation(conversation());
  assert.equal(publicState.messages.length, 2);
  assert.equal(JSON.stringify(publicState).includes('private-token'), false);
  assert.equal(JSON.stringify(publicState).includes('private-reasoning'), false);
});
test('completion marker is stable for a finished turn and absent while running',()=>{
  assert.equal(publicConversation(conversation()).completionKey,'turn-1');
  assert.equal(publicConversation(conversation({busy:true})).completionKey,null);
});
test('steering messages carry a guidance label while question replies remain ordinary answers',()=>{
  assert.equal(messageFromItem({id:'guide',type:'steeringUserMessage',input:[{type:'text',text:'先处理手机布局'}]}).guidance,true);
  assert.equal(messageFromItem({id:'user',type:'userMessage',content:[{type:'text',text:'普通提问'}]}).guidance,false);
  assert.equal(messageFromItem({id:'reply',type:'steeringUserMessage',input:[{type:'text',text:'<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>'}]}).guidance,false);
});
test('canonical history respects island order rather than map insertion order', () => {
  const base = conversation(); const one = base.turns[0];
  base.turnHistory = { kind: 'canonical', history: { entitiesByKey: { b: { ...one, turnId: 'b' }, a: { ...one, turnId: 'a' } },
    islands: [{ entries: [{ value: 'a' }, { value: 'b' }] }] } };
  assert.deepEqual(publicConversation(base).turnIds, ['a', 'b']);
});
class FakeIpc extends EventEmitter {
  constructor() { super(); this.clientId = 'client'; this.requests = []; }
  request(method, params, options) { this.requests.push({ method, params, options }); return Promise.resolve({ result: { result: { turn: { id: 'new-turn' } } } }); }
  close() {}
}
test('send routes to the desktop owner and inherits thread settings', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  bridge.threads.set('test', { owner: 'desktop-owner', state: conversation(), hostId: 'local' });
  await bridge.send('test', '发给桌面', 'unique-message');
  assert.equal(ipc.requests[0].method, 'thread-follower-start-turn');
  assert.equal(ipc.requests[0].options.targetClientId, 'desktop-owner');
  assert.equal(ipc.requests[0].params.turnStart.request.input[0].text, '发给桌面');
  assert.equal(ipc.requests[0].params.turnStart.context.inheritThreadSettings, true);
  assert.equal(ipc.requests[0].params.turnStart.context.useUserMessageAdmission, false);
});
test('local desktop send succeeds without the cloud admission extension', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  ipc.request = async (method, params) => {
    if (params.turnStart.context.useUserMessageAdmission) throw new Error('User-message admission requires a cloud app-server host');
    ipc.requests.push({ method, params });
    return { result: { result: { turn: { id: 'local-turn' } } } };
  };
  bridge.threads.set('test', { owner: 'desktop-owner', state: conversation(), hostId: 'local' });
  const result = await bridge.send('test', '手机消息', 'unique-message');
  assert.equal(result.accepted, true);
  assert.equal(result.result.turn.id, 'local-turn');
  assert.equal(ipc.requests.length, 1);
});
test('busy conversations reject sending without changing the current turn', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  bridge.threads.set('test', { owner: 'desktop-owner', state: conversation({ busy: true }), hostId: 'local' });
  await assert.rejects(bridge.send('test', 'text', 'id'), /正在执行/);
  assert.equal(ipc.requests.length, 0);
});
test('explicit steering appends to the active desktop turn without starting or interrupting a turn', async () => {
  const ipc=new FakeIpc(),bridge=new Bridge(ipc,{});
  bridge.threads.set('test',{owner:'desktop-owner',state:conversation({busy:true}),hostId:'local'});
  const result=await bridge.send('test','先处理手机布局','steer-id',{mode:'steer'});
  assert.equal(result.kind,'steered');assert.equal(ipc.requests.length,1);
  assert.equal(ipc.requests[0].method,'thread-follower-steer-turn');
  assert.equal(ipc.requests[0].options.targetClientId,'desktop-owner');
  assert.equal(ipc.requests[0].params.input[0].text,'先处理手机布局');
  assert.equal(ipc.requests[0].params.restoreMessage.id,'steer-id');
  assert.equal(Object.hasOwn(ipc.requests[0].params,'turnStart'),false);
});
test('steering after a turn ends leaves the draft unsent rather than creating another task',async()=>{
  const ipc=new FakeIpc(),bridge=new Bridge(ipc,{});
  bridge.threads.set('test',{owner:'desktop-owner',state:conversation(),hostId:'local'});
  await assert.rejects(bridge.send('test','稍等','id',{mode:'steer'}),/已结束/);
  assert.equal(ipc.requests.length,0);
});
test('stop targets the exact active turn', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  bridge.threads.set('test', { owner: 'desktop-owner', state: conversation({ busy: true }), hostId: 'local' });
  await bridge.stop('test');
  assert.equal(ipc.requests[0].params.expectedTurnId, 'turn-1');
  assert.equal(ipc.requests[0].params.mode, 'user-stop');
});
test('detached conversations never create a second execution instance', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  await assert.rejects(bridge.send('missing', 'text', 'id'), /尚未连接/);
  assert.equal(ipc.requests.length, 0);
});
test('model settings change only model and effort and require desktop readback', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  ipc.request = async (method, params, options) => {
    ipc.requests.push({ method, params, options });
    return { result: method === 'thread-follower-update-thread-settings' ? { applied: true } : { settings: { model: 'chosen-model', reasoningEffort: 'high' } } };
  };
  const state = conversation(); state.latestReasoningEffort = 'low';
  bridge.threads.set('test', { owner: 'desktop-owner', state, hostId: 'local' });
  const result = await bridge.settings('test', { model: 'chosen-model', effort: 'high', previousModel: 'test-model', previousEffort: 'low' });
  assert.deepEqual(ipc.requests[0].params.threadSettings, { model: 'chosen-model', effort: 'high' });
  assert.equal(ipc.requests[1].method, 'thread-follower-read-model-settings');
  assert.equal(result.applied, true);
});
test('a concurrent desktop model change rejects stale phone settings', async () => {
  const ipc = new FakeIpc(), bridge = new Bridge(ipc, {});
  bridge.threads.set('test', { owner: 'owner', state: conversation(), hostId: 'local' });
  await assert.rejects(bridge.settings('test', { model: 'new', effort: 'high', previousModel: 'stale', previousEffort: '' }), /已经改变/);
  assert.equal(ipc.requests.length, 0);
});
test('attachment metadata becomes file chips and the actual user message', () => {
  const text = '# Files mentioned by the user:\n\n## shot.png: C:/private/shot.png\nImage attachment: true\n\n<in-app-browser-context>internal metadata</in-app-browser-context>\n\n## My request:\n怎么优化显示？';
  const m = messageFromItem({ id: 'u', type: 'userMessage', content: [{ type: 'text', text }] });
  assert.equal(m.text, '怎么优化显示？');
  assert.deepEqual(m.attachments, ['shot.png']);
  assert.equal(m.text.includes('private'), false);
});
test('question replies show the answer instead of internal JSON wrappers', () => {
  assert.equal(visibleUserText('<send_user_message_question_reply>\n[{"question":"退出？","answer":"已退出"}]\n</send_user_message_question_reply>'), '已退出');
});
test('browser-only metadata is removed even without file attachments', () => {
  assert.equal(visibleUserText('\n<in-app-browser-context source="ambient-ui-state">\nInternal browser details\n</in-app-browser-context>\n\n## My request:\n请加时间'), '请加时间');
  assert.equal(visibleUserText('这里解释 ## My request: 这个标记'), '这里解释 ## My request: 这个标记');
});
