#!/usr/bin/env bash
# Integration test for hpa-demo: talks to a RUNNING instance over HTTP.
#   integration.sh BASE_URL [HOST_HEADER]
# Used before deploy (against the freshly built container) and after deploy (smoke test through the Ingress).
set -euo pipefail
base="${1:?usage: integration.sh BASE_URL [HOST_HEADER]}"
host="${2:-}"
curl_args=(-sS --max-time 15)
[ -n "${host}" ] && curl_args+=(-H "Host: ${host}")

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== GET /healthz"
[ "$(curl "${curl_args[@]}" "${base}/healthz")" = "ok" ] || fail "/healthz did not return 'ok'"

echo "== GET / (5 times)"
for _ in 1 2 3 4 5; do
  body="$(curl "${curl_args[@]}" "${base}/")"
  [[ "${body}" == "OK from "* ]] || fail "/ returned '${body}'"
done

echo "== GET /does-not-exist"
code="$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' "${base}/does-not-exist")"
[ "${code}" = "404" ] || fail "unknown path returned ${code}, expected 404"

echo "PASS"
