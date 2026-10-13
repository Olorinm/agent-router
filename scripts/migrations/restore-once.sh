#!/bin/sh
# Operator-supplied archive. Run as root before dropping to the Host user.
set -eu
base=/home/user/.agent-host-service
while [ ! -f "$base/ready.json" ]; do sleep 1; done
if [ ! -f "$base/restored" ]; then
  cd "$base"
  if [ ! -f migration.tgz ]; then cat migration.part* > migration.tgz; chmod 600 migration.tgz; fi
  sha256sum -c migration.sha256 >/dev/null
  # The archive is created by the operator and contains only the listed data trees.
  tar -tzf migration.tgz | awk '
    /^\// || /(^|\/)\.\.(\/|$)/ { exit 1 }
    !/^(codex-home|workspaces|projects|state\/lark|home\/user\/\.agent-host-service\/state)(\/|$)/ { exit 1 }
  '
  tar --no-same-owner -xzf migration.tgz -C /
  chown -R user:user /codex-home /workspaces /projects /state/lark "$base/state"
  chmod 700 /codex-home /workspaces /projects /state/lark "$base/state"
  touch "$base/restored"
  chmod 600 "$base/restored"
fi
exec runuser -u user -- agent-host serve --config "$base/host.json" \
  --token-file "$base/token" --ready-file "$base/ready.json" --host 0.0.0.0 --port 37420
