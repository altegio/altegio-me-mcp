# Two-stage image: build with dev dependencies, run with production ones only.
# Both stages use one node:22-alpine multi-arch index digest. To update it, pull the
# new image, check the smoke test, and change both lines together.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: husky's prepare script has no git inside the image.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json stays in the image: src/util/package-metadata.ts reads it for /health.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Exec form, so SIGTERM from Cloud Run reaches node directly.
CMD ["node", "dist/server.js"]
