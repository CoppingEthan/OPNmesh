# OPNmesh controller image. Builds the Go gateway agent (both architectures)
# and the Next.js app, then ships a small runtime image that serves the UI,
# the APIs, the installer and the agent binaries.
#
#   docker build -t opnmesh .
#   docker run -p 3000:3000 -v opnmesh-data:/data opnmesh

ARG VERSION=2.0.0-dev

# --- agent -------------------------------------------------------------------
FROM golang:1.24 AS agent
ARG VERSION
WORKDIR /src
COPY agent/go.mod agent/go.sum* ./
RUN go mod download
COPY agent/ ./
RUN set -e; \
    for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
        -ldflags "-s -w -X main.version=${VERSION}" -o /out/opnmesh-gw-linux-$arch . ; \
    done; \
    cd /out && for f in opnmesh-gw-linux-*; do sha256sum "$f" > "$f.sha256"; done

# --- web app -----------------------------------------------------------------
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
COPY --from=agent /out/ ./public/dl/
ENV OPNMESH_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
ARG VERSION
LABEL org.opencontainers.image.title="OPNmesh" \
      org.opencontainers.image.description="WireGuard site-to-site mesh controller" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    OPNMESH_DATA_DIR=/data PORT=3000 HOSTNAME=0.0.0.0 \
    OPNMESH_VERSION=${VERSION}
# iproute2: lets an operator (or the simulation) inspect and adjust routes.
RUN apt-get update -qq && apt-get install -qq -y --no-install-recommends iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY deploy/gateway/install.sh ./deploy/gateway/install.sh
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
