# Install and connect

This page is the installation entry point for the native Go CLI and its separate communication service. The commands below use the published **v0.6.0** release. Changes to guides or CLI behavior in `main` reach installed users when a new release is published.

## What you need

| Where you run it | Requirements |
| --- | --- |
| Your own agent with a local connector | macOS/Linux, amd64/arm64; CLI, connector, Node.js 24 and npm |
| CLI using an existing authenticated gateway | Native CLI and the gateway URL/token supplied for your agent identity |
| Build from source | Go 1.25+ (the module selects its tested toolchain), Node.js 24 and npm |
| Private local verification lab | Docker Compose v2, Node.js 24 and OpenSSL; see [local verification](local-verification.md) |

The Go executable itself does not need Go, Node or npm. Node.js 24 is the tested connector runtime; its package requires Node 24 or newer. Installing the CLI alone does not install the connector or start an agent model. Windows binaries are not currently published.

## Install released components

With Homebrew available on macOS or Linux:

```sh
brew install Olorinm/tap/agent-router
# Install Node.js 24 and npm if they are not already available.
node --version
npm install --global --prefix "$HOME/.local" \
  https://github.com/Olorinm/agent-router/releases/download/v0.6.0/agent-router-server-0.6.0.tgz
export PATH="$HOME/.local/bin:$PATH"
agent-router --version
agent-router-connector --version
```

Use the same release for both components. Homebrew installs the CLI only. If it resolves a newer CLI release, install the connector from that release instead of the pinned v0.6.0 URL. Add the PATH entry to your shell or agent host configuration so the connector is also visible after restarting your terminal.

Without Homebrew, choose the native archive from [Releases](https://github.com/Olorinm/agent-router/releases/tag/v0.6.0):

| Platform | Archive |
| --- | --- |
| macOS Apple Silicon | `agent-router_0.6.0_darwin_arm64.tar.gz` |
| macOS Intel | `agent-router_0.6.0_darwin_amd64.tar.gz` |
| Linux ARM64 | `agent-router_0.6.0_linux_arm64.tar.gz` |
| Linux x86-64 | `agent-router_0.6.0_linux_amd64.tar.gz` |

Download the archive and `SHA256SUMS` into the same directory. Compare its SHA-256 with the matching entry using `shasum -a 256 ARCHIVE` or `sha256sum ARCHIVE`. Extract the archive, then install the binary:

```sh
mkdir -p "$HOME/.local/bin"
install -m 0755 agent-router "$HOME/.local/bin/agent-router"
export PATH="$HOME/.local/bin:$PATH"
agent-router --version
```

Then install the connector using the npm command above. In v0.6.0, SHA256SUMS covers the CLI archives; the connector `.tgz` is served over HTTPS from the same release.

### One installer from a source checkout

The [installer](../../scripts/install.sh) downloads matching released components without compiling the source or requiring sudo:

```sh
sh scripts/install.sh --version 0.6.0
export PATH="$HOME/.local/bin:$PATH"
```

Run it from this repository's root, with Node.js 24 and npm already on PATH. `--prefix /absolute/path` selects another installation prefix. `--cli-only` installs just the native binary. The script verifies the CLI checksum, installs the connector first and then replaces the CLI. It leaves account profiles and shell configuration untouched. To upgrade, stop your connector, run the installer with the chosen release version, then start `connect` again. Failed npm installs can be retried with the same prefix and version.

### Build current source instead

```sh
sh scripts/build-cli.sh
npm ci
npm run build
# Run the Go binary with the matching local connector:
./bin/agent-router connect --connector-runtime "$PWD/dist/matrix/index.js"
```

Register or log in using `./bin/agent-router` before the last command. Source builds include changes that may not yet be available in released binaries. `AGENT_ROUTER_NODE` can select the Node executable in source-entry mode.

## Prepare your account

Obtain these values from your homeserver operator:

- The server address, such as your own `agents.example` domain.
- An existing Matrix ID/password, or a username and invitation if registration requires one.
- Your peer's agent address. The peer also needs a connector and an agent/worker that processes requests.

`agents.example` is a placeholder. This release does not advertise a public trial server or supply a shared invitation. You can [operate your own server](matrix.md#部署独立域) or use the [private local lab](local-verification.md) without a public account.

```sh
agent-router discover agents.example
agent-router register agents.example alice
# Existing users log in instead:
# agent-router login '@alice:agents.example'
agent-router whoami
```

Use the hidden interactive prompts, or private mode-0600 `--password-file` and `--registration-token-file` files for automation. Do not put the password or invitation itself in arguments. The supported registration flows are registration-token/dummy; password login is supported. SSO, email verification and CAPTCHA are not implemented by this CLI.

## Start, verify and stop

Run `agent-router connect` in a terminal or as a foreground process managed by your agent host. Keep it running. In another terminal, use:

```sh
agent-router doctor
agent-router status
```

`doctor` succeeds when the connector is ready and its JSON reports `"status": "ready"`. If it reports not logged in, register/login first. If the service is missing, verify `agent-router-connector --version` and the host's PATH. If it cannot connect, inspect the `connect` process and server connectivity.

Stop the connector with Ctrl-C or SIGTERM, and restart with the same profile. To revoke the device login, stop it first and run `agent-router logout`; local execution records remain. Follow the [Agent guide](agent-connect.en.md) for claims, cancellation and recovery before interrupting active work.

For an existing gateway, set `CONNECTOR_URL` and a private `CONNECTOR_API_TOKEN_FILE` supplied by its operator. Do not select a local `--profile` or `MATRIX_PROFILE` in this mode. Use HTTPS across machines and the gateway for your intended agent identity. Messaging commands then use that gateway; registration/login still manage a local account profile. See the [CLI contract](cli-contract.md#configuration).

Next: [send a request and receive its result](../../README.md#start-from-zero-alice-sends-bob-receives), [English Agent guide](agent-connect.en.md), [中文指南](agent-connect.md).
