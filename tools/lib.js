// The fingerprint of tools/: one SHA-256 over every file in this folder except FINGERPRINT.
// It is printed at the top of every log. The rubric states the value it has to be.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = join(TOOLS, '..');

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function fingerprint() {
  const h = createHash('sha256');
  for (const p of walk(TOOLS)) {
    const rel = relative(TOOLS, p).replaceAll('\\', '/');
    if (rel === 'FINGERPRINT') continue;
    h.update(rel + '\n');
    h.update(readFileSync(p, 'utf8').replaceAll('\r\n', '\n'));
  }
  return h.digest('hex').slice(0, 16);
}
