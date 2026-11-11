# It builds and it runs. That is all that can be said for it.
FROM node:latest
WORKDIR /app
COPY . .
ENV ADMIN_TOKEN=dev-secret
ENV APP_VERSION=1.0.0
CMD npm start
