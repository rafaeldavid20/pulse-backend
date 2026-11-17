import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/common/pql');
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
const header = '// GENERATED from pulse-app/src/lib/pql; do not edit.\n';
const files = readdirSync(dir).filter(name => name.endsWith('.ts')).sort();
if (manifest.version !== 1 || JSON.stringify(files) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('PQL generated file list differs from manifest.');
for (const file of files) {
  const contents = readFileSync(resolve(dir, file), 'utf8');
  if (!contents.startsWith(header) || createHash('sha256').update(contents.slice(header.length)).digest('hex') !== manifest.files[file]) throw new Error(`PQL generated file drift: ${file}`);
}
console.log('PQL generated files match manifest.');
