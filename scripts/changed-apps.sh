#!/usr/bin/env bash
# changed-apps.sh push BEFORE AFTER   -> JSON list of apps to build/deploy for a push
# changed-apps.sh dispatch APP|all    -> JSON list for a manual run
# changed-apps.sh deployable JSON     -> the same list without apps that have deploying switched off
#
# Switching deploys off for an app: add the file apps/NAME/deploy.disabled (its text says why). The app is
# still tested, scanned and built, but not onboarded and not deployed to DEV or PRD. Delete the file to switch
# deploying back on.
# An "app" is any folder apps/NAME that has a k8s/ folder.
# If shared files changed (anything outside apps/), every app is rebuilt/redeployed.
# Deleted apps are ignored: removing a running app is a manual, irreversible step.
set -euo pipefail
cd "$(dirname "$0")/.."

all_apps() { for d in apps/*/k8s; do [ -d "${d}" ] && basename "$(dirname "${d}")"; done; }
to_json() { python3 -I -c 'import json,sys; print(json.dumps(sorted(set(l.strip() for l in sys.stdin if l.strip()))))'; }

mode="${1:?usage: changed-apps.sh push BEFORE AFTER | dispatch APP|all}"
case "${mode}" in
  dispatch)
    want="${2:-all}"
    if [ "${want}" = "all" ]; then all_apps | to_json; else
      [ -d "apps/${want}/k8s" ] || { echo "apps/${want}/k8s not found" >&2; exit 1; }
      echo "${want}" | to_json
    fi
    ;;
  push)
    before="${2:-}"; after="${3:?missing AFTER}"
    if [ -z "${before}" ] || [ "${before}" = "0000000000000000000000000000000000000000" ] || \
       ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
      all_apps | to_json; exit 0
    fi
    changed="$(git diff --name-only "${before}" "${after}")"
    if echo "${changed}" | grep -qv '^apps/'; then
      all_apps | to_json
    else
      echo "${changed}" | awk -F/ '{print $2}' | while read -r a; do
        [ -d "apps/${a}/k8s" ] && echo "${a}"
      done | to_json
    fi
    ;;
  deployable)
    echo "${2:?missing JSON list}" | python3 -I -c 'import json,sys; [print(a) for a in json.load(sys.stdin)]' |
      while read -r a; do [ -f "apps/${a}/deploy.disabled" ] || echo "${a}"; done | to_json
    ;;
  *) echo "unknown mode ${mode}" >&2; exit 1 ;;
esac
