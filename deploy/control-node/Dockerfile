# Control node image: Next.js UI + the agent-facing API in one process.
# Built from the repo root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
    && npx esbuild scripts/control-server.ts --bundle --platform=node --format=esm \
       --outfile=dist/control-server.mjs \
       --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);"

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/dist/control-server.mjs ./control-server.mjs
COPY --from=build /app/config/sites.example.yml ./config/sites.example.yml
COPY deploy/control-node/start.sh ./start.sh
RUN chmod +x ./start.sh     && mkdir -p /var/lib/opnmesh/config /var/lib/opnmesh/data     && chown -R node:node /app /var/lib/opnmesh
# A container escape or an RCE in Node must not be uid 0.
USER node
EXPOSE 8080
CMD ["./start.sh"]
