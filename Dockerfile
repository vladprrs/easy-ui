FROM node:24-slim

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV SERVE_DIST=dist DATA_DIR=data HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
CMD ["bun","server/main.ts"]
