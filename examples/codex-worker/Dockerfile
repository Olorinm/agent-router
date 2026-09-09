# Reuse pinned, locally verified images when deploying without registry access.
ARG CODEX_IMAGE
ARG ROUTER_IMAGE
FROM ${CODEX_IMAGE} AS codex
FROM ${ROUTER_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=codex /app/node_modules/@openai /opt/codex/node_modules/@openai
COPY worker.mjs /app/worker.mjs
ENV CODEX_BIN=/opt/codex/node_modules/@openai/codex/bin/codex.js
USER node
ENTRYPOINT ["node", "/app/worker.mjs"]
