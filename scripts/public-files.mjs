import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// One publication boundary, shared by the scanner and release packager.
export const publicDirectories = new Set(['src', 'public', 'desktop', 'integrations', 'scripts', 'test', 'docs', '.github']);
export const publicRootFiles = new Set([
  '.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', 'package-lock.json', 'build.ps1', 'start.cmd', 'RELEASE-MANIFEST.json',
]);
export const localDirectories = new Set([
  '.git', '.local', '.codex', '.claude', '.idea', '.vscode', 'node_modules', 'dist',
  'release', 'releases', 'coverage', 'work', 'outputs', 'tmp', 'temp',
]);
export function localFile(path) {
  return /(?:^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith('.env.example')
    || /\.(?:exe|dll|zip|7z|log|jsonl|sqlite[^/]*|db|db-[^/]*|pfx|p12|pem|key|crt|cer|bak|tmp)$/i.test(path)
    || /(?:^|\/)(?:Thumbs\.db|\.DS_Store)$/.test(path);
}
export function publicPath(path) {
  const parts = path.split('/');
  return parts.length === 1 ? publicRootFiles.has(path) : publicDirectories.has(parts[0]);
}
export function inventory(root) {
  const files = [], unexpected = [], links = [];
  const walk = (dir, prefix = '') => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + item.name, full = join(dir, item.name);
      if (lstatSync(full).isSymbolicLink()) { links.push(path); continue; }
      if (item.isDirectory()) {
        if (localDirectories.has(item.name)) continue;
        if (!prefix && !publicDirectories.has(item.name)) { unexpected.push(path + '/'); continue; }
        walk(full, path + '/');
      } else if (!prefix && localFile(path)) continue;
      else if (!publicPath(path)) unexpected.push(path);
      else files.push(path);
    }
  };
  walk(root);
  return { files: files.sort(), unexpected, links };
}
