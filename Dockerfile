FROM node:24-slim

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

ENV SERVE_DIST=dist DATA_DIR=data HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["bun","server/main.ts"]
