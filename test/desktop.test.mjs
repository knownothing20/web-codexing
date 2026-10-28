import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('Windows launcher supports persistent startup settings, native icons and safe desktop shortcuts', { skip:process.platform !== 'win32', timeout:60000 }, () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Windows CI exposes an 8.3 temp alias; COM returns canonical long paths.
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'remote-coding-desktop-')));
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'test', 'desktop-check.ps1'),
      '-ProjectRoot', root, '-TestRoot', scratch,
    ], { cwd:root, encoding:'utf8', windowsHide:true, timeout:55000 });
    assert.match(output, /Desktop checks passed/);
    const ico = readFileSync(join(scratch, 'embedded.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 8);
    const sizes = [];
    let end = 6 + 16 * 8;
    for (let i = 0; i < 8; i++) {
      const entry = 6 + 16 * i;
      const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
      sizes.push(ico[entry] || 256);
      assert.equal(offset, end);
      assert.ok(ico.subarray(offset, offset + 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
      end += length;
    }
    assert.deepEqual(sizes, [16,20,24,32,48,64,128,256]);
    assert.equal(end, ico.length);
  } finally { rmSync(scratch, { recursive:true, force:true }); }
});
