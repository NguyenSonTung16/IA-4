import { config } from './config.js';
import { open } from './db.js';
import { createApp } from './app.js';

// Keep the handle in a variable that outlives startup. createApp only keeps the prepared
// statements, and when nothing else holds the database, the garbage collector can free it and
// every statement then fails with "statement has been finalized" (seen on Node 22.13.1).
const db = open(config.dbPath);
const server = createApp(db, config);
server.listen(config.port, () =>
  console.log(`linkbox ${config.version} (${config.env}) on :${config.port}, db ${config.dbPath}`));

// `docker stop` sends SIGTERM and kills after 10 s. Stop taking new connections, let requests
// already in flight finish, close idle keep-alive connections, then close the database and exit.
function shutdown(signal) {
  console.log(`${signal}: draining`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 200).unref();
  setTimeout(() => process.exit(1), 7000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
