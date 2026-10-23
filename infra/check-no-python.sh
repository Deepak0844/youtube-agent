#!/usr/bin/env bash
# Fails if any given image contains an entry named python, python3 or python3.N
# (file or symlink). Inspects the image filesystem, not the Dockerfile, so base
# images and apt dependencies are covered. Exit: 0 clean, 1 python found, 2 could not check.
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: check-no-python.sh IMAGE..." >&2; exit 2; }

status=0
for image in "$@"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null 2>&1 || { echo "cannot pull $image" >&2; exit 2; }
  id=$(docker create "$image" 2>/dev/null) || { echo "cannot create container from $image" >&2; exit 2; }
  listing=$(mktemp)
  # Names only (`tar -tf`): with -v the last field of a symlink line is its target, not its name.
  # Works for images without a shell.
  if ! { docker export "$id" | tar -tf - > "$listing"; } 2>/dev/null; then
    docker rm -f "$id" >/dev/null; rm -f "$listing"
    echo "cannot read filesystem of $image" >&2
    exit 2
  fi
  docker rm -f "$id" >/dev/null
  found=$(grep -v '/$' "$listing" | grep -E '(^|/)python(3(\.[0-9]+)*)?$' || true)
  rm -f "$listing"
  if [ -n "$found" ]; then
    echo "FAIL $image contains python:" >&2
    echo "$found" | head -5 >&2
    status=1
  else
    echo "ok   $image"
  fi
done
exit $status
