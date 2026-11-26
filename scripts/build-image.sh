#!/usr/bin/env bash
# build-image.sh APP -> builds apps/APP/app (Dockerfile), runs the integration test and the image security scan
# against the built image, and only then pushes it to GHCR. Skips if:
#   - the app has no Dockerfile (it uses a ready-made image), or
#   - the image for that commit already exists (only manifests or scripts changed): then it's pulled, tested and
#     scanned again instead, and not pushed.
# Expects GITHUB_TOKEN (GitHub's short-lived per-run token) and GITHUB_ACTOR.
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:?usage: build-image.sh APP}"

if [ ! -f "apps/${app}/app/Dockerfile" ]; then
  echo "apps/${app}/app/Dockerfile not found: nothing to build."
  exit 0
fi

image="$(scripts/image-tag.sh "${app}")"
echo "${GITHUB_TOKEN:?GITHUB_TOKEN not set}" | docker login ghcr.io -u "${GITHUB_ACTOR:?GITHUB_ACTOR not set}" --password-stdin
trap 'docker logout ghcr.io >/dev/null' EXIT

if docker manifest inspect "${image}" >/dev/null 2>&1; then
  echo "${image} already exists: not rebuilding, but testing and scanning it again (new vulnerabilities appear over time)."
  docker pull -q "${image}" >/dev/null
  scripts/integration-test.sh "${app}" "${image}"
  scripts/security-scan.sh image "${image}"
  exit 0
fi

# The source label links the package to this public repo (that's what makes it public and visible there).
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.source=https://github.com/zulhardy-lab/devops-projects" \
  -t "${image}" "apps/${app}/app"
scripts/integration-test.sh "${app}" "${image}"
scripts/security-scan.sh image "${image}"
docker push "${image}"
echo "Pushed ${image}"
