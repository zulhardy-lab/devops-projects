#!/usr/bin/env bash
# App pipeline steps that run on the homelab's self-hosted runner (ops01), from .github/workflows/apps.yml.
# GitHub Actions only. DEPLOY ONLY: this repo can't onboard apps. Onboarding (namespaces <app>-dev / <app>-prd,
# deployer accounts, OpenBao roles) is owned by the homelab repo: its allowed-apps list `homelab_apps`
# (ansible/inventory/group_vars/all.yml), applied by its own pipeline after the platform approval.
#
#   ci-apps.sh onboarded '["app1","app2"]' OUTFILE -> writes the JSON list of those apps that ARE onboarded to
#                                                   OUTFILE; prints a warning for each one that isn't
#                                                   (OpenBao role projects-check: read-only)
#   ci-apps.sh deploy APP dev|prd                  -> deploy with that environment's 10-minute deployer token,
#                                                   then smoke-test through the Ingress
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/ci-openbao-login.sh
source scripts/lib/ci-openbao-login.sh
# shellcheck source=scripts/lib/envs.sh
source scripts/lib/envs.sh

[ -r /etc/rancher/k3s/server-ca.crt ] || { echo "Missing /etc/rancher/k3s/server-ca.crt (not on the homelab runner?)" >&2; exit 1; }

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/apps.XXXXXX")"
chmod 700 "${work}"
cleanup() { openbao_logout; rm -rf "${work}"; }
trap cleanup EXIT

case "${1:-}" in
  onboarded)
    apps_json="${2:?missing apps JSON}"; out="${3:?missing OUTFILE}"
    openbao_login projects-check >/dev/null
    ready=()
    while read -r app; do
      [ -n "${app}" ] || continue
      if bao read "kubernetes/roles/dev-${app}" >/dev/null 2>&1 && bao read "kubernetes/roles/prd-${app}" >/dev/null 2>&1; then
        ready+=("${app}")
      else
        echo "::warning title=${app} not onboarded::${app} is not onboarded on the homelab, so it is not deployed. Add it to homelab_apps in the homelab repo (ansible/inventory/group_vars/all.yml) in a pull request; after the platform approval it can deploy."
      fi
    done < <(python3 -I -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "${apps_json}")
    python3 -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${ready[@]}" > "${out}"
    echo "Onboarded (will deploy): $(cat "${out}")"
    ;;

  deploy)
    app="${2:?missing APP}"; env="${3:?missing ENV}"
    env_check "${env}"
    if [ -f "apps/${app}/deploy.disabled" ]; then
      echo "Deploying ${app} is switched off (apps/${app}/deploy.disabled). Not deploying." >&2; exit 1
    fi
    if [ "${env}" = "prd" ]; then echo "== Approval gate"; require_protected_environment prd; fi
    echo "== OpenBao login (projects-${env})"; openbao_login "projects-${env}"
    openbao_k8s_token "${env}-${app}" "${app}-${env}" "${work}/deployer.jwt"
    write_kubeconfig "${work}/deployer.kubeconfig" "${work}/deployer.jwt" "${app}-${env}"
    KUBECONFIG="${work}/deployer.kubeconfig" scripts/deploy.sh "${app}" "${env}"

    echo "== Smoke test (${env})"
    host="$(env_host "${app}" "${env}")"; ip="$(env_node_ip "${env}")"
    if ! compgen -G "apps/${app}/k8s/[0-9][0-9]-*ingress*.yaml" >/dev/null; then
      echo "${app} has no Ingress: nothing reachable from outside to smoke-test."
    elif [ -x "apps/${app}/tests/integration.sh" ]; then
      ok=""
      for _ in $(seq 1 20); do curl -s -o /dev/null -H "Host: ${host}" "http://${ip}/" && { ok=1; break; }; sleep 3; done
      [ -n "${ok}" ] || { echo "Ingress ${host} not answering." >&2; exit 1; }
      "apps/${app}/tests/integration.sh" "http://${ip}" "${host}"
    else
      echo "FAIL: ${app} has an Ingress but no apps/${app}/tests/integration.sh" >&2; exit 1
    fi
    ;;

  *) echo "usage: ci-apps.sh onboarded JSON OUTFILE | deploy APP dev|prd" >&2; exit 1 ;;
esac
