#!/usr/bin/env bash
# Fails if any given image contains an executable named python or python3.
# Inspects the image filesystem (not the Dockerfile) so base images and apt deps are covered.
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: check-no-python.sh IMAGE..." >&2; exit 2; }

status=0
for image in "$@"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null || { echo "cannot pull $image" >&2; exit 2; }
  id=$(docker create "$image" 2>/dev/null) || { echo "cannot create container from $image" >&2; exit 2; }
  # Export works for images without a shell; /proc, /sys and /dev are not in the export.
  found=$(docker export "$id" | tar -tvf - 2>/dev/null | awk '{print $1, $NF}' \
    | grep -E ' (\./)?([^ ]*/)?python3?$' | grep -E '^[-l]..x|^l' || true)
  docker rm -f "$id" >/dev/null
  if [ -n "$found" ]; then
    echo "FAIL $image contains python:" >&2
    echo "$found" | head -5 >&2
    status=1
  else
    echo "ok   $image"
  fi
done
exit $status
