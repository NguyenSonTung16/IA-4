// Run a migration from inside an image, as a one-off container on the database volume.
//   npm run migrate:image -- v2          (up)
//   npm run migrate:image -- v2 down     (revert the last step)
import { spawnSync } from 'node:child_process';

const [tag, direction = 'up'] = process.argv.slice(2);
if (!tag) { console.error('usage: npm run migrate:image -- <tag> [up|down]'); process.exit(2); }

const r = spawnSync('docker', ['compose', 'run', '--rm', '--no-deps', '-T', 'blue', 'node', 'src/migrate.js', direction], {
  stdio: 'inherit',
  timeout: 120_000,
  killSignal: 'SIGKILL',
  env: { ...process.env, BLUE_TAG: tag },
});
if (r.status !== 0) { console.error('migration failed'); process.exit(1); }

// Leaves a line in the running load log, so that the order of migration and deploy is on the record.
await fetch('http://127.0.0.1:8081/mark', { method: 'POST', body: `migration ${direction} from linkbox:${tag}` }).catch(() => {});
