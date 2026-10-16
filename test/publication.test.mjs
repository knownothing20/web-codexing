import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanProject, scanText, safePng } from '../scripts/privacy-check.mjs';
import { allowedAddress } from '../src/network.mjs';
import { createDemoServer } from '../scripts/preview-demo.mjs';
import { fileURLToPath } from 'node:url';

test('publication scan detects credentials and private context without returning matched values', () => {
  const credential = ['sk', 'ant', 'x'.repeat(32)].join('-');
  const content = ['hello', credential, ['C:', 'Users', 'private-person', 'file.txt'].join('/'), ['192','168','9','9'].join('.'), ['person','real-mail.org'].join('@')].join('\n');
  const findings = scanText(content);
  assert.deepEqual(findings.map(f => f.rule).sort(), ['provider-key','personal-home','private-network-address','personal-email'].sort());
  assert.equal(JSON.stringify(findings).includes(credential), false);
  assert.equal(findings.find(f => f.rule === 'provider-key').line, 2);
  assert.deepEqual(scanText('person@example.com http://127.0.0.1:3210 C:/path/to/project'), []);
});

test('publication boundary excludes local data, rejects nested runtime files and unreviewed binaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-'));
  try {
    mkdirSync(join(root,'.local')); writeFileSync(join(root,'.local','runtime.json'), 'private');
    mkdirSync(join(root,'node_modules')); writeFileSync(join(root,'node_modules','private.json'), 'private');
    writeFileSync(join(root,'README.md'), 'Safe public documentation');
    writeFileSync(join(root,'RemoteCoding.exe'), 'old local binary');
    assert.deepEqual(scanProject(root).findings, []);
    mkdirSync(join(root,'docs')); writeFileSync(join(root,'docs','runtime.json'), '{}');
    writeFileSync(join(root,'docs','recording.mp4'), 'binary');
    writeFileSync(join(root,'notes-private.txt'), 'private');
    const rules = scanProject(root).findings.map(f => f.rule);
    assert.ok(rules.includes('private-runtime-file')); assert.ok(rules.includes('unreviewed-file-type')); assert.ok(rules.includes('unlisted-public-path'));
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('publication scan catches ignored secrets in Git index even after working file is cleaned or removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-index-'));
  const git = args => execFileSync('git',args,{cwd:root,stdio:'pipe',windowsHide:true});
  try {
    git(['init','--quiet']);
    writeFileSync(join(root,'.gitignore'), '.env\n'); writeFileSync(join(root,'.env'), 'PRIVATE=local');
    git(['add','--force','.env']); rmSync(join(root,'.env'));
    writeFileSync(join(root,'README.md'), ['sk', 'x'.repeat(32)].join('-')); git(['add','README.md']);
    writeFileSync(join(root,'README.md'), 'clean working copy');
    const findings = scanProject(root).findings;
    assert.ok(findings.some(f => f.file === '.env' && f.rule === 'private-or-unlisted-file-in-index'));
    assert.ok(findings.some(f => f.file === 'README.md' && f.rule === 'provider-key'));
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('PNG preview gate rejects metadata and unknown binary files', () => {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const chunk = (type, data) => { const h=Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(type,4); return Buffer.concat([h,data,Buffer.alloc(4)]); };
  const good = Buffer.concat([signature,chunk('IHDR',Buffer.alloc(13)),chunk('IDAT',Buffer.from([1])),chunk('IEND',Buffer.alloc(0))]);
  assert.equal(safePng(good),true);
  assert.equal(safePng(Buffer.concat([good,Buffer.from('private')])),false);
  assert.equal(safePng(Buffer.concat([signature,chunk('IHDR',Buffer.alloc(13)),chunk('tEXt',Buffer.from('private')),chunk('IDAT',Buffer.from([1])),chunk('IEND',Buffer.alloc(0))])),false);
  assert.equal(safePng(Buffer.from('not a PNG')),false);
});

test('Git index privacy checks still apply when a Windows directory has an alternate path', { skip:process.platform !== 'win32' }, () => {
  const base=mkdtempSync(join(tmpdir(),'publication-path-')), root=join(base,'repository'), alias=join(base,'alias');
  mkdirSync(root);
  try {
    execFileSync('git',['init','--quiet'],{cwd:root,stdio:'pipe',windowsHide:true});
    writeFileSync(join(root,'.env'),'PRIVATE=local');
    execFileSync('git',['add','--force','.env'],{cwd:root,stdio:'pipe',windowsHide:true});
    symlinkSync(root,alias,'junction');
    assert.ok(scanProject(alias).findings.some(f=>f.file==='.env' && f.rule==='private-or-unlisted-file-in-index'));
  } finally { rmSync(base,{recursive:true,force:true}); }
});

test('Tailscale direct IPv4 range requires explicit enable and never permits arbitrary public peers', () => {
  const tail = (...parts) => parts.join('.');
  for (const ip of [tail(100,64,0,1),tail(100,127,255,254)]) {
    assert.equal(allowedAddress(ip),false); assert.equal(allowedAddress(ip,{tailscale:true}),true);
    assert.equal(allowedAddress('::ffff:'+ip,{tailscale:true}),true);
  }
  for (const ip of [tail(100,63,255,254),tail(100,128,0,1),'8.8.8.8','999.1.1.1']) assert.equal(allowedAddress(ip,{tailscale:true}),false);
  assert.equal(allowedAddress('127.0.0.1'),true);
});

test('public demo serves only synthetic data and never submits actions', async () => {
  const server=createDemoServer(); await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    assert.match(await (await fetch(base+'/')).text(),/公开演示/);
    assert.equal((await fetch(base+'/read-state.js')).status,200);
    for(const module of ['service-tier.js','notifications.js']) {
      const asset=await fetch(base+'/'+module);assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
    }
    assert.equal((await (await fetch(base+'/api/status')).json()).computer,'演示电脑 · DEMO');
    assert.equal((await fetch(base+'/api/threads/demo-chat/send',{method:'POST',body:'{}'})).status,409);
    assert.equal((await fetch(base+'/runtime.json')).status,404);
  } finally { await server.stopDemo(); }
});

test('README relative document and preview links exist in the publication inventory', () => {
  const root=new URL('..',import.meta.url), readme=readFileSync(new URL('README.md',root),'utf8');
  const paths=[...readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)|<img src="([^"]+)"/g)].map(m=>m[1]||m[2]).filter(p=>!/^https?:/.test(p));
  const published=new Set(scanProject(fileURLToPath(root)).files);
  for(const path of paths) { assert.equal(existsSync(new URL(path,root)),true,path); assert.ok(published.has(path),path); }
});
