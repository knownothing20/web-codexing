import { readFileSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inventory, localDirectories, localFile, publicPath } from './public-files.mjs';

const textExtensions = /\.(?:mjs|js|cs|json|html|css|svg|webmanifest|md|txt|yml|yaml|ps1|cmd)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['provider-key', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['credential-url', /https?:\/\/[^\s/:'"<>]+:[^\s/@'"<>]+@/g],
  ['literal-credential', /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|localKey|pairCode|csrf)\b["']?\s*[:=]\s*["'][A-Za-z0-9_+./=-]{16,}["']/gi],
  ['authorization', /\bBearer\s+[A-Za-z0-9_.+/-]{24,}/g],
  ['session-cookie', /rc_session=[a-f0-9]{64}/gi],
  ['personal-home', /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<)[^\s\\/'"<>]+|\/(?:home|Users)\/(?!example\b|<)[A-Za-z0-9_.-]+)/g],
  ['personal-project-path', /[A-Za-z]:[\\/]+(?:GitHub|workspace)[\\/]+[^\s'"<>;,)}]+/gi],
  ['private-network-address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g],
];
const deniedNames = /(?:^|\/)(?:runtime|paired-devices|credentials|auth|settings|receipt|steer-receipt|history-reply-receipt)\.json$/i;

export function scanText(text) {
  const findings = [];
  for (const [rule, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const domain = match[0].split('@')[1].toLowerCase();
    if (!/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/.test(domain)) findings.push({ rule: 'personal-email', line: text.slice(0, match.index).split('\n').length });
  }
  return findings;
}

// PNG previews must be metadata-free. No EXIF, text chunks or hidden trailing bytes.
export function safePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
  const allowed = new Set(['IHDR','PLTE','IDAT','IEND','tRNS','sRGB','gAMA','pHYs','cHRM']);
  let offset = 8, header = false, data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!allowed.has(type) || offset + 12 + length > bytes.length) return false;
    if (!header && (type !== 'IHDR' || length !== 13)) return false;
    header = true; if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') return data && length === 0 && offset === bytes.length;
  }
  return false;
}

function gitFiles(root) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0) {
    if (existsSync(join(root, '.git'))) throw new Error('Cannot inspect publication Git repository');
    return [];
  }
  // Windows runners can use a short (8.3) temp path while Git reports its long path.
  // Compare filesystem identities rather than treating this as a non-repository.
  const canonical = path => {
    const value = realpathSync.native(resolve(path));
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  if (canonical(top.stdout.trim()) !== canonical(root)) return [];
  // Inspect the index even for ignored files or files deleted from the working tree.
  const result = spawnSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Cannot inspect Git index');
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

export function scanProject(root, { builtArtifacts = new Map() } = {}) {
  const list = inventory(root), findings = [];
  const add = (file, rule, line = 0) => findings.push({ file, rule, line });
  for (const file of list.links) add(file, 'symbolic-link');
  for (const file of list.unexpected) if (!builtArtifacts.has(file)) add(file, 'unlisted-public-path');
  const indexed = gitFiles(root);
  for (const file of indexed) {
    if (file.split('/').some(p => localDirectories.has(p)) || localFile(file) || !publicPath(file)) add(file, 'private-or-unlisted-file-in-index');
    const mode = spawnSync('git', ['ls-files', '-s', '--', file], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (/^120000 /.test(mode.stdout || '')) add(file, 'symbolic-link-in-index');
    const blob = spawnSync('git', ['show', ':' + file], { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (blob.status !== 0) { add(file, 'unreadable-index-content'); continue; }
    inspect(file, blob.stdout);
  }
  function inspect(file, bytes) {
    if (localFile(file) || deniedNames.test(file) || file.split('/').some(p => localDirectories.has(p))) { add(file, 'private-runtime-file'); return; }
    if (/^docs\/previews\/[^/]+\.png$/.test(file)) {
      if (bytes.length > 4 * 1024 * 1024 || !safePng(bytes)) add(file, 'unsafe-preview-format-or-metadata');
      return;
    }
    if (!textExtensions.test(file) && !['LICENSE','.gitignore','.gitattributes'].includes(file)) { add(file, 'unreviewed-file-type'); return; }
    if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) { add(file, 'oversized-or-binary-source'); return; }
    for (const finding of scanText(bytes.toString('utf8'))) add(file, finding.rule, finding.line);
  }
  for (const file of list.files) {
    const full = join(root, file);
    if (!existsSync(full) || !lstatSync(full).isFile()) { add(file, 'unreadable-file'); continue; }
    inspect(file, readFileSync(full));
  }
  for (const [file, hash] of builtArtifacts) {
    if (file !== 'RemoteCoding.exe' || createHash('sha256').update(readFileSync(join(root, file))).digest('hex') !== hash) add(file, 'unverified-build-artifact');
  }
  return { files: list.files, findings: [...new Map(findings.map(f => [JSON.stringify(f), f])).values()] };
}

export function report(result) {
  if (!result.findings.length) { console.log(`Privacy check passed: ${result.files.length} publication files; index and working tree checked where available.`); return true; }
  console.error(`Privacy check FAILED (${result.findings.length}). Matched values are intentionally hidden:`);
  for (const { file, rule, line } of result.findings) console.error(`  ${file}${line ? ':' + line : ''} [${rule}]`);
  return false;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root')) throw new Error('Usage: node scripts/privacy-check.mjs [--root DIRECTORY]');
  process.exitCode = report(scanProject(resolve(args[1] || join(fileURLToPath(new URL('..', import.meta.url)))))) ? 0 : 1;
}
