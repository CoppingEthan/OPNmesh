# Simulation node image: userspace WireGuard (wireguard-go) so no host kernel
# module is needed and behaviour is identical on Windows, WSL and CI.
# wireguard-go is not packaged for Alpine, so build it from source.
FROM golang:1.23-alpine AS wg-go
RUN apk add --no-cache git make
RUN git clone --depth 1 https://git.zx2c4.com/wireguard-go /src \
    && cd /src \
    && go build -o /wireguard-go .

# The OPNmesh agent, built from ./agent (build context is the repo root).
FROM golang:1.23-alpine AS agent
COPY agent/ /build/
RUN cd /build && go vet ./... && go test ./... && go build -o /opnmesh-agent .

FROM alpine:3.20

RUN apk add --no-cache \
    bash \
    iproute2 \
    iputils \
    nftables \
    wireguard-tools \
    iperf3 \
    tcpdump \
    netcat-openbsd \
    curl

COPY --from=wg-go /wireguard-go /usr/bin/wireguard-go
COPY --from=agent /opnmesh-agent /usr/bin/opnmesh-agent

ENV WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go

COPY docker/entrypoints/ /opt/opnmesh/
RUN chmod +x /opt/opnmesh/*.sh
