FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/server.js server/sync-client.js server/sync.css ./
COPY server/public/ ./public/
USER node
EXPOSE 3000
CMD ["node","server.js"]
