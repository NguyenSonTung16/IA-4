// npm run drill:build -- v2     builds linkbox:v3-bad from linkbox:v2 and the fault.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!tag) { console.error('usage: npm run drill:build -- <tag of your good image>'); process.exit(2); }
const dir = fileURLToPath(new URL('.', import.meta.url));
const r = spawnSync('docker', ['build', '-q', '-f', `${dir}Dockerfile.bad`, '--build-arg', `BASE=linkbox:${tag}`, '-t', 'linkbox:v3-bad', dir], { stdio: 'inherit' });
process.exit(r.status ?? 1);
