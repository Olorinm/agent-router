#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${AGENT_ROUTER_VERSION:-0.6.0}" -o bin/agent-router ./cmd/agent-router
