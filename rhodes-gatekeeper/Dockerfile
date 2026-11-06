# ---------- build web ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- build server ----------
FROM node:22-bookworm-slim AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST_DIR=/app/web/dist STORAGE_DIR=/data/files
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /data/files && chown -R node:node /data
VOLUME ["/data/files"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run automatically at start-up.
CMD ["node", "dist/index.js"]
