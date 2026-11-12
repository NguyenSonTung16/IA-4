// Configuration comes from the environment, so one image runs in every environment.
//   APP_ENV      development (default) | staging | production
//   PORT         default 3000
//   DB_PATH      default ./data/app.db
//   BASE_URL     default http://localhost:<PORT>
//   ADMIN_TOKEN  required in production; the built-in development value is refused there
//   APP_VERSION  baked into the image at build time
const env = process.env.APP_ENV ?? 'development';
const port = Number(process.env.PORT ?? 3000);

const DEV_TOKEN = 'dev-secret';

// Say which variable is wrong, never what its value was.
function refuse(reason) {
  console.error(`linkbox: refusing to start in ${env}: ${reason}`);
  process.exit(1);
}

let adminToken = process.env.ADMIN_TOKEN;
if (env === 'production') {
  if (!adminToken) refuse('ADMIN_TOKEN is not set');
  if (adminToken === DEV_TOKEN) refuse('ADMIN_TOKEN is the development default; set a real token');
} else {
  adminToken ||= DEV_TOKEN;
}

export const config = {
  env,
  port,
  dbPath: process.env.DB_PATH ?? './data/app.db',
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  adminToken,
  version: process.env.APP_VERSION ?? 'dev',
};
