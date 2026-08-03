# Base image pinned by digest (plan 2026-08-03-renderer-contract-2 R0, T-M5): the raster
# stack (fontconfig/freetype/system fonts) is a renderer-fingerprint input — a drifting
# floating tag would silently change it. Bump manually together with rendererPin.json (R1+).
FROM node:24-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

WORKDIR /app
COPY package*.json ./
RUN npm ci
# Screenshot worker: install chromium + its runtime libraries into the image.
# PLAYWRIGHT_BROWSERS_PATH keeps the browser cache inside the final image layer.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --no-install playwright install --with-deps chromium
COPY . .
RUN npm run build

# Renderer manifest (plan 2026-08-03-renderer-contract-2, R0). ARG is declared here
# on purpose: earlier it would invalidate the npm/playwright layer cache on every commit.
ARG EASYUI_BUILD_SHA
RUN node scripts/renderer-manifest.mjs > /app/renderer-manifest.json && cat /app/renderer-manifest.json
ENV EASYUI_RENDERER_MANIFEST=/app/renderer-manifest.json

ENV SERVE_DIST=dist DATA_DIR=data HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["bun","server/main.ts"]
