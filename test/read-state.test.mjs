import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadTracker } from '../public/read-state.js';
const store = () => { const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}; };

test('old completions and later pages form a read baseline on a new or migrated browser', () => {
  const storage=store(); storage.setItem('rc_seen_completions_v1','[]');
  const tracker=createReadTracker(storage,1000);
  assert.equal(tracker.observe('old',{status:'idle',completionKey:'old-turn',completedAt:900}),false);
  assert.equal(tracker.observe('older-page',{status:'idle',completionKey:'older-turn',completedAt:800}),false);
  assert.equal(tracker.observe('unknown-time',{status:'idle',completionKey:'old-turn'}),false);
});
test('new completion stays unread across refresh until viewed; next completed turn lights again', () => {
  const storage=store(); let tracker=createReadTracker(storage,1000);
  const done={status:'idle',completionKey:'new-turn',completedAt:2000};
  assert.equal(tracker.observe('chat',done),true);
  tracker=createReadTracker(storage,3000); assert.equal(tracker.observe('chat',done),true);
  tracker.markRead('chat','new-turn'); assert.equal(tracker.observe('chat',done),false);
  tracker=createReadTracker(storage,4000); assert.equal(tracker.observe('chat',done),false);
  assert.equal(tracker.observe('chat',{...done,completionKey:'next-turn',completedAt:5000}),true);
});
test('live task transition detects completion even when old protocol has no completion timestamp', () => {
  const tracker=createReadTracker(store(),1000);
  assert.equal(tracker.observe('chat',{status:'running',completionKey:null}),false);
  assert.equal(tracker.observe('chat',{status:'idle',completionKey:'finished'}),true);
  assert.equal(tracker.observe('chat',{status:'idle',completionKey:'finished'}),true);
  tracker.markRead('chat','finished'); assert.equal(tracker.observe('chat',{status:'idle',completionKey:'finished'}),false);
});
