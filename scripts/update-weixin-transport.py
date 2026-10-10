#!/usr/bin/env python3
"""Vendor only Tencent's transport/login code; no OpenClaw runtime is installed."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--version', default='2.4.9')
args = parser.parse_args()
if not all(c.isdigit() or c == '.' for c in args.version):
    raise SystemExit('Use an explicit stable package version.')
root = Path(__file__).resolve().parents[1]
target = root / 'src/channels/weixin/vendor'
metadata = json.load(urllib.request.urlopen('https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/' + args.version))
payload = urllib.request.urlopen(metadata['dist']['tarball']).read()
algorithm, expected = metadata['dist']['integrity'].split('-', 1)
if base64.b64encode(hashlib.new(algorithm, payload).digest()).decode() != expected:
    raise SystemExit('Package integrity mismatch.')
target.mkdir(parents=True, exist_ok=True)
files = {
    'src/api/api.ts': 'api.ts',
    'src/api/types.ts': 'types.ts',
    'src/auth/login-qr.ts': 'login-qr.ts',
    'src/util/redact.ts': 'redact.ts',
    'LICENSE': 'LICENSE',
}
manifest = {'package': metadata['name'], 'version': args.version, 'integrity': metadata['dist']['integrity'],
            'source': 'https://github.com/Tencent/openclaw-weixin', 'files': {}}
with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
    for source, destination in files.items():
        raw = archive.extractfile('package/' + source).read()
        manifest['files'][source] = hashlib.sha256(raw).hexdigest()
        text = raw.decode()
        if destination.endswith('.ts'):
            text = '// @ts-nocheck -- pinned upstream transport; adapted imports/config only.\n' + text
            text = text.replace('"../api/api.js"', '"./api.js"').replace('"../auth/accounts.js"', '"../config.js"')
            text = text.replace('"./accounts.js"', '"../config.js"').replace('"../util/logger.js"', '"../logger.js"')
            text = text.replace('"../util/redact.js"', '"./redact.js"')
            if destination == 'api.ts':
                text = text.replace('import crypto', 'import { upstreamPackage } from "./upstream.js";\nimport crypto', 1)
                text = text.replace('const pkg = readPackageJson();', 'const pkg = upstreamPackage;')
        (target / destination).write_text(text)
package = {k: metadata.get(k, '') for k in ['name', 'version', 'ilink_appid']}
(target / 'upstream.ts').write_text('export const upstreamPackage = ' + json.dumps(package) + ';\n')
(target / 'upstream.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Vendored Tencent Weixin transport', args.version)
