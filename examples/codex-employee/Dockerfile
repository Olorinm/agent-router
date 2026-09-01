FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CODEX_HOME=/var/lib/codex
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist
COPY entrypoint.sh /usr/local/bin/employee-entrypoint
RUN chmod 0555 /usr/local/bin/employee-entrypoint \
  && mkdir -p /workspace /var/lib/codex \
  && chown -R node:node /workspace /var/lib/codex
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/employee-entrypoint"]
