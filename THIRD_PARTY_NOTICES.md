# Third-party source

`src/channels/weixin/vendor/` contains selected transport, protocol, QR login, AES media and CDN URL source from
Tencent's [`@tencent-weixin/openclaw-weixin` 2.4.9](https://github.com/Tencent/openclaw-weixin),
Copyright (C) 2026 Tencent, under MIT. The complete license is included in
`src/channels/weixin/vendor/LICENSE` and copied to `dist/channels/weixin/vendor/LICENSE` during builds.

Imports and local configuration are adapted for Agent Router. The upstream API package metadata
is pinned rather than discovered from this project's package.json. Upstream file hashes and
the npm archive integrity are recorded in `vendor/upstream.json`.
`scripts/update-weixin-transport.py --version 2.4.9` reproduces this extraction.
The OpenClaw runtime is not included or required.

Feishu uses the official Lark SDK 1.74.0 and official [`@larksuite/cli` 1.0.97](https://github.com/larksuite/cli)
as npm dependencies. The latter installs its upstream checksum-verified binary and retains its MIT license.
Telegram uses grammY; their licenses
remain with their distributed packages. Matrix continues to use the existing matrix-js-sdk transport.
