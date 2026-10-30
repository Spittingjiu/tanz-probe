# Multi-stage lightweight build for Tanz Probe Master Panel
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5555

# Install curl and tzdata for container health checks and logging
RUN apk add --no-cache curl tzdata

# Copy dependency definitions and install production packages
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

EXPOSE 5555

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fs http://127.0.0.1:5555/api/status >/dev/null || exit 1

CMD ["node", "server.js"]
