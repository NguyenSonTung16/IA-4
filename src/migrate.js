// Apply or revert schema migrations, one pair of files per step:
//   migrations/NNN_name.up.sql   and   migrations/NNN_name.down.sql
//
//   node src/migrate.js up        applies every pending step
//   node src/migrate.js down      reverts the LAST applied step only
//   node src/migrate.js status    lists what is applied
//
// Run inside the image, so a migration ships with the code that needs it:
//   npm run migrate:image -- v2
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { open } from './db.js';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const db = open(config.dbPath);
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

const versions = readdirSync(DIR).filter((f) => f.endsWith('.up.sql')).sort().map((f) => f.replace('.up.sql', ''));
const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));

function run(sql, after) {
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(sql); after(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'up') {
  const pending = versions.filter((v) => !applied.has(v));
  if (!pending.length) console.log('nothing to apply');
  for (const v of pending) {
    run(readFileSync(join(DIR, `${v}.up.sql`), 'utf8'), () =>
      db.prepare("INSERT INTO schema_migrations VALUES (?, datetime('now'))").run(v));
    console.log(`applied  ${v}`);
  }
} else if (cmd === 'down') {
  const last = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  if (!last) { console.log('nothing to revert'); process.exit(0); }
  const file = join(DIR, `${last.version}.down.sql`);
  if (!existsSync(file)) { console.error(`no ${last.version}.down.sql: this step has no way back`); process.exit(1); }
  run(readFileSync(file, 'utf8'), () => db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(last.version));
  console.log(`reverted ${last.version}`);
} else {
  for (const v of versions) console.log(`${applied.has(v) ? '[x]' : '[ ]'} ${v}`);
}
