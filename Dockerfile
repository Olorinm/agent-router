FROM node:26-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist
COPY --from=build /build/migrations ./migrations
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
