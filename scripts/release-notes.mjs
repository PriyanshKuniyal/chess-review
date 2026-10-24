// Prints release notes for a version: install steps plus that version's CHANGELOG section.
//   node scripts/release-notes.mjs v1.2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] || '').replace(/^v/, '');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const start = changelog.search(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?`, 'm'));
let section = '';
if (start >= 0) {
  const rest = changelog.slice(start).split('\n').slice(1).join('\n');
  const end = rest.search(/^## /m);
  section = (end >= 0 ? rest.slice(0, end) : rest).trim();
}

console.log(`## Install (Windows)

1. Download **Chess-Review-v${version}-windows-x64.zip** below and unzip it anywhere.
2. Double-click **Chess Review.exe**. Stockfish and Node.js are included; nothing else is required.
3. Optional: for written move explanations, install [Ollama](https://ollama.com/download) and click **Set up coach** in the app.

Upgrading? Unzip over your old folder or into a new one; your analysis cache lives in the \`cache\` folder.

## What's new

${section || '_See the commit history._'}
`);
