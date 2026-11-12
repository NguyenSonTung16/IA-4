import { config } from './config.js';
import { open } from './db.js';
import { createApp } from './app.js';

const server = createApp(open(config.dbPath), config);
server.listen(config.port, () =>
  console.log(`linkbox ${config.version} (${config.env}) on :${config.port}, db ${config.dbPath}`));

// `docker stop` sends SIGTERM and kills after 10 s. Stop taking new connections, let requests
// already in flight finish, close idle keep-alive connections, then exit.
function shutdown(signal) {
  console.log(`${signal}: draining`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 200).unref();
  setTimeout(() => process.exit(1), 7000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
