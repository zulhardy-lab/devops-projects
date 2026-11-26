#!/usr/bin/env bash
# integration-test.sh APP [IMAGE] -> starts the app's container and runs apps/APP/tests/integration.sh against it.
#   IMAGE defaults to a local build of apps/APP/app. Required for apps with a Dockerfile.
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:?usage: integration-test.sh APP [IMAGE]}"
test_script="apps/${app}/tests/integration.sh"

if [ ! -f "apps/${app}/app/Dockerfile" ]; then
  echo "${app} has no Dockerfile: no container to test before deploy (the post-deploy smoke test still runs)."
  exit 0
fi
[ -x "${test_script}" ] || { echo "FAIL: ${app} has no executable ${test_script}." >&2; exit 1; }

image="${2:-}"
if [ -z "${image}" ]; then
  image="local/${app}:integration"
  docker build -q -t "${image}" "apps/${app}/app" >/dev/null
fi

name="it-${app}-$$"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "${name}" -P --read-only --cap-drop ALL --security-opt no-new-privileges "${image}" >/dev/null
port="$(docker port "${name}" | head -1 | sed 's/.*://')"
[ -n "${port}" ] || { echo "FAIL: the image exposes no port (add EXPOSE to the Dockerfile)." >&2; exit 1; }
base="http://127.0.0.1:${port}"

for _ in $(seq 1 30); do curl -s -o /dev/null "${base}/" && break; sleep 1; done
"${test_script}" "${base}" || { echo "--- container logs"; docker logs "${name}" 2>&1 | tail -20; exit 1; }
