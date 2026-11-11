// v1 configuration. Every environment gets the same values, because they are written here.
export const config = {
  env: 'development',
  port: 3000,
  dbPath: './data/app.db',
  baseUrl: 'http://localhost:3000',
  adminToken: 'dev-secret',
  version: process.env.APP_VERSION ?? 'dev',
};
