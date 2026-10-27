import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inlineParts} from '../public/inline-format.js';

test('file references support angle brackets, Chinese, spaces and desktop drive prefixes',()=>{
  for(const [source,path,name] of [
    ['[审核包（NAS，27.7 MB）](</srv/example/reviews/review-v2.zip>)','/srv/example/reviews/review-v2.zip','review-v2.zip'],
    ['[快速版](</D:/Example Workflows/中文 快速版.json>)','D:/Example Workflows/中文 快速版.json','中文 快速版.json'],
    ['[质量版]\n(<D:\\Example Workflows\\中文 (质量版).json>)','D:\\Example Workflows\\中文 (质量版).json','中文 (质量版).json'],
  ]){const parts=inlineParts(source);assert.equal(parts.length,1);assert.equal(parts[0].type,'file');assert.equal(parts[0].path,path);assert.equal(parts[0].name,name);}
});
test('web links, code and emphasis remain distinct and unsafe protocols are inert text',()=>{
  assert.deepEqual(inlineParts('[说明](<https://example.com/a b>)'),[{type:'link',text:'说明',url:'https://example.com/a%20b'}]);
  assert.deepEqual(inlineParts('`[示例](</srv/example.zip>)`'),[{type:'code',text:'[示例](</srv/example.zip>)'}]);
  assert.equal(inlineParts('**重点**')[0].type,'strong');
  for(const destination of ['javascript:alert','file:///C:/secret.txt','data:text/plain,hello','https://'])assert.equal(inlineParts(`[标签](${destination})`)[0].type,'text');
  assert.deepEqual(inlineParts('普通文字 [未完成'),[{type:'text',text:'普通文字 [未完成'}]);
});
