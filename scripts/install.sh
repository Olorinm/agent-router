#!/bin/sh
# Install a released Go CLI and its matching connector into a user-owned prefix.
set -eu

install_version=${AGENT_ROUTER_VERSION:-0.6.0}
install_prefix=${AGENT_ROUTER_INSTALL_PREFIX:-"$HOME/.local"}
install_connector=true
usage() {
  cat <<'EOF'
Usage: sh scripts/install.sh [--version VERSION] [--prefix DIRECTORY] [--cli-only]

Downloads the native Go CLI and installs the matching connector release.
Default: version 0.6.0, prefix $HOME/.local. No sudo or source compilation.
The connector requires Node.js 24+ and npm. --cli-only needs neither.
Profiles, accounts and shell configuration are not changed.
EOF
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--prefix)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in --version) install_version=$2 ;; --prefix) install_prefix=$2 ;; esac
      shift 2 ;;
    --cli-only) install_connector=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done
case "$install_version" in ''|*[!0-9A-Za-z.-]*) fail 'Invalid release version; use a version such as 0.6.0 without the v prefix.' ;; esac
case "$install_prefix" in /*) ;; *) fail 'Installation prefix must be an absolute path.' ;; esac
case "$(uname -s)" in Darwin) install_os=darwin ;; Linux) install_os=linux ;; *) fail 'Supported platforms: macOS and Linux.' ;; esac
case "$(uname -m)" in arm64|aarch64) install_arch=arm64 ;; x86_64|amd64) install_arch=amd64 ;; *) fail 'Supported architectures: amd64 and arm64.' ;; esac
for install_tool in curl tar awk install mktemp; do
  command -v "$install_tool" >/dev/null 2>&1 || fail "Missing required tool: $install_tool"
done
if command -v shasum >/dev/null 2>&1; then
  install_hash=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  install_hash=sha256sum
else
  fail 'Install shasum or sha256sum to verify the CLI download.'
fi
if [ "$install_connector" = true ]; then
  command -v node >/dev/null 2>&1 || fail 'Install Node.js 24 and npm first, or use --cli-only for an existing gateway.'
  command -v npm >/dev/null 2>&1 || fail 'Install npm first, or use --cli-only for an existing gateway.'
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail 'The connector requires Node.js 24 or newer.'
fi

mkdir -p "$install_prefix/bin"
install_stage=$(mktemp -d "$install_prefix/.agent-router-install.XXXXXX")
trap 'rm -rf "$install_stage"' 0
trap 'exit 1' 1 2 15
install_base="https://github.com/Olorinm/agent-router/releases/download/v$install_version"
install_archive="agent-router_${install_version}_${install_os}_${install_arch}.tar.gz"
download() {
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 180 --retry 2 "$install_base/$1" --output "$install_stage/$1"
}
printf 'Downloading Agent Router %s for %s/%s\n' "$install_version" "$install_os" "$install_arch"
download "$install_archive"
download SHA256SUMS
install_expected=$(awk -v name="$install_archive" '$2 == name || $2 == "./" name {print $1}' "$install_stage/SHA256SUMS")
[ -n "$install_expected" ] || fail 'The release checksum file does not list this CLI archive.'
if [ "$install_hash" = shasum ]; then
  install_actual=$(shasum -a 256 "$install_stage/$install_archive" | awk '{print $1}')
else
  install_actual=$(sha256sum "$install_stage/$install_archive" | awk '{print $1}')
fi
[ "$install_actual" = "$install_expected" ] || fail 'CLI checksum mismatch; installation stopped.'
mkdir "$install_stage/cli"
tar -xzf "$install_stage/$install_archive" -C "$install_stage/cli" agent-router
[ -f "$install_stage/cli/agent-router" ] && [ ! -L "$install_stage/cli/agent-router" ] || fail 'The CLI archive must contain a regular agent-router binary.'

if [ "$install_connector" = true ]; then
  install_package="agent-router-server-${install_version}.tgz"
  download "$install_package"
  # Connector packages are distributed by HTTPS in the same GitHub release.
  # v0.6.0's SHA256SUMS covers the CLI archives only.
  npm install --global --prefix "$install_prefix" --no-audit --no-fund "$install_stage/$install_package"
  "$install_prefix/bin/agent-router-connector" --version
fi
# Move the new CLI into place only after the connector install succeeds.
install -m 0755 "$install_stage/cli/agent-router" "$install_stage/agent-router"
mv -f "$install_stage/agent-router" "$install_prefix/bin/agent-router"
"$install_prefix/bin/agent-router" --version
printf '\nInstalled in %s/bin. Add that directory to PATH.\n' "$install_prefix"
printf '%s\n' 'Next: obtain your homeserver address and account/invitation, then run:' \
  '  agent-router register SERVER USERNAME  # or: agent-router login ADDRESS' \
  '  agent-router connect                  # keep this process running' \
  '  agent-router doctor                   # from another terminal'
if [ "$install_connector" = false ]; then
  printf '%s\n' 'CLI-only mode: use your existing authenticated gateway, or install the connector before running connect.'
fi
