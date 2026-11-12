# linkbox v1: same behaviour as the starter, packaged to be released.
# Pinned base: alpine keeps the image small and still has `sh` and `wget` (health check, checks).
FROM node:22.13.1-alpine

# The version is baked at build time:  docker build --build-arg APP_VERSION=1.0.0 -t linkbox:v1 .
ARG APP_VERSION=1.0.0
ENV APP_VERSION=${APP_VERSION} \
    NODE_ENV=production

WORKDIR /app

# /data is where the database volume is mounted; the unprivileged user must be able to write there.
RUN mkdir -p /data && chown node:node /data

# Only what the service needs to run (see .dockerignore for what stays out).
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations

USER node
EXPOSE 3000

# Configuration (APP_ENV, BASE_URL, DB_PATH, ADMIN_TOKEN, PORT) comes from the environment at run
# time; no secret is written into the image.
HEALTHCHECK --interval=2s --timeout=2s --start-period=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

# Exec form, so node is PID 1 and receives SIGTERM from `docker stop`.
# Migrations are NOT run here: they are a separate step (npm run migrate:image).
CMD ["node", "src/server.js"]
