import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanProject, report } from './privacy-check.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.some(a => a !== '--windows') || args.length > 1) throw new Error('Usage: node scripts/package-release.mjs [--windows]');
if (process.platform !== 'win32') throw new Error('ZIP packaging uses the Windows build environment. CI privacy checks run on any platform.');
const windows = args.includes('--windows');
const run = (file, args, cwd = root) => execFileSync(file, args, { cwd, stdio: 'inherit', windowsHide: true });
// No skip flag: every package must pass both tests and privacy checks.
run(process.execPath, ['--test', 'test/*.test.mjs']);
const source = scanProject(root);
if (!report(source)) process.exit(1);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Invalid version');
mkdirSync(join(root, '.local'), { recursive: true });
const staging = mkdtempSync(join(root, '.local', 'release-'));
for (const file of source.files) {
  const target = join(staging, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, file), target);
}
const artifacts = new Map();
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (windows) {
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(staging, 'build.ps1'), '-OutputPath', join(staging, 'RemoteCoding.exe')], staging);
  artifacts.set('RemoteCoding.exe', sha(join(staging, 'RemoteCoding.exe')));
}
const staged = scanProject(staging, { builtArtifacts: artifacts });
if (!report(staged)) process.exit(1);
const files = [...staged.files, ...artifacts.keys()].filter(p => p !== 'RELEASE-MANIFEST.json').sort();
writeFileSync(join(staging, 'RELEASE-MANIFEST.json'), JSON.stringify({ name: 'web-codexing', version, kind: windows ? 'windows-launcher-and-source' : 'source', node: '>=24', generatedAt: new Date().toISOString(), files: Object.fromEntries(files.map(p => [p, sha(join(staging, p))])) }, null, 2) + '\n');
if (!report(scanProject(staging, { builtArtifacts: artifacts }))) process.exit(1);
const dist = join(root, 'dist'); mkdirSync(dist, { recursive: true });
const name = `web-codexing-${version}-${windows ? 'windows' : 'source'}-${Date.now()}.zip`;
const zip = join(dist, name);
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'archive.ps1'), '-Source', staging, '-Destination', zip]);
writeFileSync(zip + '.sha256', `${sha(zip)}  ${name}\n`);
console.log(`Created dist/${name} and SHA256. Nothing uploaded. Windows packages require Node.js 24+ and npm ci --omit=dev --ignore-scripts.`);
