# The deploy artifact: one binary that serves the API, the WebSocket and the
# client, built the same way `make build` builds it locally — client first,
# straight into the Go binary's embed directory, then the binary around it.

# --- the client -------------------------------------------------------------
FROM node:22-alpine AS client
WORKDIR /src

# The lockfile alone first, so a source-only change does not reinstall.
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
# Vite's outDir is ../server/internal/web/dist, so this writes into the path
# the Go build below expects. Nothing copies it by hand.
RUN cd client && npm run build

# --- the binary -------------------------------------------------------------
FROM golang:1.26-alpine AS server
WORKDIR /src

COPY server/go.mod server/go.sum ./server/
RUN cd server && go mod download

COPY server/ ./server/
# After the sources, so a client-only change invalidates the build layer. This
# is the Docker equivalent of the `touch web.go` in the Makefile: without it
# the embedded file list would be whatever the cache last saw.
COPY --from=client /src/server/internal/web/dist/ ./server/internal/web/dist/

RUN cd server && CGO_ENABLED=0 go build -trimpath -o /out/pomodorus ./cmd/server

# --- what ships -------------------------------------------------------------
FROM alpine:3

# ca-certificates: the push services and the SMTP relay are both TLS.
# curl: Liara's health check runs inside this container, so it has to be here.
# tzdata is deliberately absent — the binary embeds it via `time/tzdata`, and
# Tehran day bucketing must not depend on the image.
RUN apk add --no-cache ca-certificates curl

RUN adduser -D -H -u 10001 pomodorus
USER pomodorus

# Facts about this deployment rather than secrets. Everything secret — the
# database URL, the SMTP credentials, the VAPID keypair — is set on the app,
# never baked into an image.
ENV ENV=production \
    ADDR=:8081 \
    TRUST_PROXY_HEADERS=1

EXPOSE 8081

COPY --from=server /out/pomodorus /usr/local/bin/pomodorus
CMD ["pomodorus"]
