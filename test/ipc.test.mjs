import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameReader,frame} from '../src/ipc.mjs';

test('an image-heavy snapshot above the old 64 MiB limit and subsequent frames remain readable',()=>{
  // Stream synthetic JSON without building another giant serialized input.
  // Padding stands in for desktop-only tool/image data; no user data is used.
  const size=65*1024*1024, prefix=Buffer.from('{"padding":"'),suffix=Buffer.from('","text":"中文完成"}');
  const header=Buffer.alloc(4);header.writeUInt32LE(prefix.length+size+suffix.length);
  const received=[],reader=new FrameReader(message=>received.push({length:message.padding?.length,text:message.text}));
  reader.push(header.subarray(0,1));reader.push(header.subarray(1));reader.push(prefix);
  const chunk=Buffer.alloc(64*1024,0x78);
  for(let n=0;n<size;n+=chunk.length)reader.push(chunk.subarray(0,Math.min(chunk.length,size-n)));
  const tail=frame({text:'下一条增量'});
  reader.push(Buffer.concat([suffix,tail.subarray(0,2)]));reader.push(tail.subarray(2));
  assert.deepEqual(received,[{length:size,text:'中文完成'},{length:undefined,text:'下一条增量'}]);
});

test('frame limits reject empty, excessive and forged lengths before reading a body',()=>{
  for(const size of [0,128*1024*1024+1,0xffffffff]){
    const header=Buffer.alloc(4);header.writeUInt32LE(size);
    const reader=new FrameReader(()=>assert.fail('invalid frame delivered'));
    reader.push(header.subarray(0,3));
    assert.throws(()=>reader.push(header.subarray(3)),/IPC 帧超出限制/);
    assert.equal(reader.body,null);
  }
  const header=Buffer.alloc(4);header.writeUInt32LE(1025);
  assert.throws(()=>new FrameReader(()=>{},1024).push(header),/IPC 帧超出限制/);
});

test('truncated and malformed JSON is never delivered as a successful frame',()=>{
  const seen=[],reader=new FrameReader(message=>seen.push(message)),packet=frame({text:'完整'});
  reader.push(packet.subarray(0,packet.length-1));assert.deepEqual(seen,[]);
  reader.push(packet.subarray(packet.length-1));assert.deepEqual(seen,[{text:'完整'}]);
  const bad=Buffer.from('not-json'),header=Buffer.alloc(4);header.writeUInt32LE(bad.length);
  assert.throws(()=>reader.push(Buffer.concat([header,bad])),SyntaxError);
  assert.equal(seen.length,1);
});
