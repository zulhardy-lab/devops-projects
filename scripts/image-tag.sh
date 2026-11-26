#!/usr/bin/env bash
# image-tag.sh APP -> ghcr.io/zulhardy-lab/APP:sha-<last commit that changed apps/APP/app>
# Used by both build and deploy, so they always agree on the exact image. Needs full git history.
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:?usage: image-tag.sh APP}"
sha="$(git log -1 --format=%H -- "apps/${app}/app")"
if [ -z "${sha}" ]; then
  echo "No commit found for apps/${app}/app (missing folder, or a shallow clone?)" >&2
  exit 1
fi
echo "ghcr.io/zulhardy-lab/${app}:sha-${sha}"
