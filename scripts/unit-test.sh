#!/usr/bin/env bash
# unit-test.sh APP -> runs the app's unit tests. Required: an app without unit tests fails.
#   apps/APP/tests/test_*.py   -> python3 -m unittest (standard library)
#   apps/APP/tests/unit.sh     -> any other language: this script runs it
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1  # no __pycache__ folders next to the app code
cd "$(dirname "$0")/.."
app="${1:?usage: unit-test.sh APP}"
t="apps/${app}/tests"

if [ -x "${t}/unit.sh" ]; then
  "${t}/unit.sh"
elif compgen -G "${t}/test_*.py" >/dev/null; then
  python3 -m unittest discover -s "${t}" -v
else
  echo "FAIL: ${app} has no unit tests (add ${t}/test_*.py or an executable ${t}/unit.sh)." >&2
  exit 1
fi
