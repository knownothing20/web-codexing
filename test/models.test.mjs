import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {catalogFixture} from './catalog-fixture.mjs';
import {getModels} from '../src/models.mjs';

test('model catalog reuses its cache and updates after the desktop catalog changes',async()=>{
  const dir=mkdtempSync(join(resolve('.local'),'models-check-'));
  const keys=['REMOTE_CODING_CODEX','NODE_OPTIONS','CODEX_HOME'],previous=keys.map(key=>process.env[key]);
  try{
    Object.assign(process.env,catalogFixture(dir),{CODEX_HOME:dir});
    const first=await getModels();assert.equal((await getModels()),first);
    writeFileSync(join(dir,'models_cache.json'),'{}');
    const refreshed=await getModels();assert.notEqual(refreshed,first);
    assert.equal(refreshed.models[0].id,'demo-fast');
    assert.equal((await getModels()),refreshed);
  }finally{
    keys.forEach((key,i)=>previous[i]===undefined?delete process.env[key]:process.env[key]=previous[i]);
    rmSync(dir,{recursive:true,force:true});
  }
});
