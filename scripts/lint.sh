#!/usr/bin/env bash
# Lint checks for every PR (yamllint, shellcheck). Pipeline YAML only calls this script, so the same
# check can move to Azure Pipelines later without rewriting the logic.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== yamllint =="
yamllint -d relaxed .

echo "== shellcheck =="
command -v shellcheck >/dev/null || { echo "shellcheck not installed" >&2; exit 1; }
shellcheck scripts/*.sh scripts/lib/*.sh
shopt -s nullglob
app_scripts=(apps/*/tests/*.sh)
[ "${#app_scripts[@]}" -eq 0 ] || shellcheck "${app_scripts[@]}"

echo "All checks passed."
