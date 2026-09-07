#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
release_version=${AGENT_ROUTER_VERSION:-0.6.0}
release_dir=${AGENT_ROUTER_RELEASE_DIR:-state/release}
mkdir -p "$release_dir"
for release_os in darwin linux; do
  for release_arch in amd64 arm64; do
    release_name="agent-router_${release_version}_${release_os}_${release_arch}"
    release_stage="$release_dir/$release_name"
    mkdir -p "$release_stage"
    CGO_ENABLED=0 GOOS="$release_os" GOARCH="$release_arch" go build -trimpath -ldflags "-s -w -X main.version=$release_version" -o "$release_stage/agent-router" ./cmd/agent-router
    cp LICENSE "$release_stage/LICENSE"
    tar -czf "$release_dir/$release_name.tar.gz" -C "$release_stage" agent-router LICENSE
  done
done
(cd "$release_dir" && shasum -a 256 ./*.tar.gz > SHA256SUMS)
