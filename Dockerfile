# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY src/web/public ./dist/web/public

RUN addgroup -S tippybot && adduser -S tippybot -G tippybot \
  && mkdir -p /app/data /app/auth_cache /app/logs /app/config \
  && chown -R tippybot:tippybot /app
USER tippybot

# No bots.config.json/​.env is baked in -- both live in the /app/config volume
# (see docker-compose.yml). WEB_HOST=0.0.0.0 (the app default) is required
# here: 127.0.0.1 inside the container is not reachable through a published
# port.
ENV BOTS_CONFIG_PATH=/app/config/bots.config.json
ENV DOTENV_CONFIG_PATH=/app/config/.env

EXPOSE 3000

# Confirms only that the web server's TCP port is accepting connections --
# no HTTP request, no auth. Assumes WEB_ENABLED=true (the default); remove
# this if you run with the web UI disabled.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:net').connect({port:process.env.WEB_PORT||3000,host:'127.0.0.1'}).on('connect',function(){this.end();process.exit(0)}).on('error',function(){process.exit(1)})"

CMD ["node", "dist/index.js"]
