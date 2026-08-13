.DEFAULT_GOAL := help
.PHONY: help up down logs dev server client build run test test-server test-client fmt tidy psql mail clean

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

## up: start Postgres and Mailpit
up:
	docker compose up -d
	@echo "postgres :5433   mailpit smtp :1025   mailpit inbox http://localhost:8025"

## down: stop them (data survives)
down:
	docker compose down

## logs: tail the containers
logs:
	docker compose logs -f

## dev: run the Go API and the Vite client together
# The client is served by Vite and proxies /api and /ws to the Go server, so
# the browser stays on one origin and cookies behave as they will in prod.
dev: up
	@trap 'kill 0' INT TERM EXIT; \
	(cd server && go run ./cmd/server) & \
	(cd client && npm run dev) & \
	wait

## server: run only the Go API
server: up
	cd server && go run ./cmd/server

## client: run only the Vite dev server
client:
	cd client && npm run dev

## build: build the client into the binary, producing one deployable artifact
build:
	cd client && npm run build
	@# The embedded file list is cached by the Go build; touching the embedding
	@# file is what makes a client-only change actually reach the binary.
	touch server/internal/web/web.go
	cd server && go build -o ../bin/pomodorus ./cmd/server
	@echo "built bin/pomodorus"

## run: run the built binary (serves the API and the client on :8081)
run: build
	./bin/pomodorus

## test: run every test
test: test-server test-client

## test-server: Go tests (integration tests need `make up`)
test-server:
	cd server && go test ./...

## test-client: Vitest
test-client:
	cd client && npm test

## fmt: format Go
fmt:
	cd server && go fmt ./...

## tidy: tidy Go modules
tidy:
	cd server && go mod tidy

## psql: open a shell on the dev database
psql:
	docker exec -it pomodorus-postgres psql -U pomodorus -d pomodorus

## mail: open the Mailpit inbox
mail:
	open http://localhost:8025

## clean: remove build output and the database volume
clean:
	rm -rf bin server/internal/web/dist/*
	touch server/internal/web/dist/.gitkeep
	docker compose down -v
