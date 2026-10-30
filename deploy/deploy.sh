#!/usr/bin/env bash
# Deploy maniac-duo to a box: the app as committed (HEAD), with these deploy
# files as they are now.
#
#   deploy/deploy.sh <ssh host>     # e.g. mbp-server-001.lab.home.arpa
#
# Only committed files are sent (git archive), so rom/, out/ and data/ never
# leave this machine. Games live in a Docker volume on the box and survive a
# redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${1:?usage: deploy/deploy.sh <ssh host>}
DIR=/opt/maniac-duo
rev=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- src tools package.json bun.lock tsconfig.json)" ] ||
	echo "deploy: uncommitted app changes are NOT deployed; deploying $rev" >&2

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git archive HEAD | tar -x -C "$stage"
rm -rf "$stage/deploy"
cp -R deploy "$stage/deploy"
echo "$rev" >"$stage/REVISION"
if find "$stage" -iname '*.nes' | grep -q .; then
	echo "deploy: a ROM is in what would be sent; refusing" >&2
	exit 1
fi

tar --no-xattrs -c -C "$stage" . | ssh "$HOST" "set -e
	sudo install -d -o \$(id -un) -g \$(id -gn) $DIR
	find $DIR -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	tar -x -C $DIR
	cd $DIR
	docker compose -f deploy/compose.yaml up -d --build
	docker compose -f deploy/compose.yaml ps --format '{{.Service}}: {{.Status}}'
	echo \"deployed maniac-duo \$(cat REVISION)\""
