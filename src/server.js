import { config } from './config.js';
import { open } from './db.js';
import { createApp } from './app.js';

const server = createApp(open(config.dbPath), config);
server.listen(config.port, () =>
  console.log(`linkbox ${config.version} (${config.env}) on :${config.port}, db ${config.dbPath}`));
