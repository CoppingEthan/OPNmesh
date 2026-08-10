# Simulation node image: userspace WireGuard (wireguard-go) so no host kernel
# module is needed and behaviour is identical on Windows, WSL and CI.
# wireguard-go is not packaged for Alpine, so build it from source.
FROM golang:1.23-alpine AS wg-go
RUN apk add --no-cache git make
RUN git clone --depth 1 https://git.zx2c4.com/wireguard-go /src \
    && cd /src \
    && go build -o /wireguard-go .

FROM alpine:3.20

RUN apk add --no-cache \
    bash \
    iproute2 \
    iputils \
    nftables \
    wireguard-tools \
    iperf3 \
    tcpdump \
    netcat-openbsd

COPY --from=wg-go /wireguard-go /usr/bin/wireguard-go

ENV WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go

COPY entrypoints/ /opt/opnmesh/
RUN chmod +x /opt/opnmesh/*.sh
