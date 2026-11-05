# Two-stage image: build with dev dependencies, run with production ones only.
# Both stages use one node:26.13.0-alpine multi-arch index digest. To update it, pull the
# new image, check the smoke test, and change both lines together.
FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: husky's prepare script has no git inside the image.
RUN npm install --global npm@12.2.2 --ignore-scripts && npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
ARG COMMIT_SHA
LABEL org.opencontainers.image.source="https://github.com/altegio/altegio-me-mcp"
LABEL org.opencontainers.image.revision=$COMMIT_SHA
ENV NODE_ENV=production
WORKDIR /app
# package.json stays in the image: src/util/package-metadata.ts reads it for /health.
COPY package.json package-lock.json ./
RUN npm install --global npm@12.2.2 --ignore-scripts && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Exec form, so SIGTERM from Cloud Run reaches node directly.
CMD ["node", "dist/server.js"]
