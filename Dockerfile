FROM golang:1.26.8-bookworm AS cli
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY docs/guides ./docs/guides
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.6.0" -o /agent-router ./cmd/agent-router

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=cli /agent-router ./bin/agent-router
COPY scripts/matrix ./scripts/matrix
COPY docs/guides ./docs/guides
USER node
ENV PATH="/app/bin:${PATH}" AGENT_ROUTER_CONNECTOR_ENTRY=/app/dist/matrix/index.js
CMD ["node", "dist/matrix/index.js"]
