#!/bin/sh
# Wrapper Chrome launches: resolves the node runtime and the host script
# relative to wherever Noishi installed them, then execs the real host.
set -eu
DIR=$(dirname "$(readlink -f "$0")")
NODE=${NOISHI_NODE:-$(command -v node || true)}
if [ -z "$NODE" ]; then
	echo '{"ok":false,"error":"node não encontrado"}' >&2
	exit 1
fi
exec "$NODE" "$DIR/noishi-native-host.mjs"
