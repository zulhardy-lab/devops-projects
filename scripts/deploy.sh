#!/usr/bin/env bash
# deploy.sh APP ENV -> applies apps/APP/k8s/NN-*.yaml (numbered files only, in order) to namespace APP-ENV
# (ENV = dev or prd), then waits until every Deployment and StatefulSet in it is healthy.
#
# Works with any kubeconfig: yours (admin) or the pipeline's 10-minute deployer token.
# Placeholders replaced in the manifests:
#   APP_IMAGE          -> image built for this commit (or the APP_IMAGE environment variable, if set)
#   APP_INGRESS_HOST   -> prd: APP.192.168.0.103.nip.io (prd01)   dev: APP.192.168.0.104.nip.io (dev01)
#                         (or the APP_INGRESS_HOST environment variable; see scripts/lib/envs.sh)
#   APP_ENV            -> dev or prd (lets manifests differ per environment if ever needed)
# Optional: SKIP_INGRESS=1 skips files with "ingress" in their name.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/envs.sh
source scripts/lib/envs.sh
app="${1:?usage: deploy.sh APP dev|prd}"
env="${2:?usage: deploy.sh APP dev|prd}"
env_check "${env}"
ns="${app}-${env}"
dir="apps/${app}/k8s"
[ -d "${dir}" ] || { echo "${dir} not found" >&2; exit 1; }

image="${APP_IMAGE:-}"
if [ -z "${image}" ] && [ -f "apps/${app}/app/Dockerfile" ]; then
  image="$(scripts/image-tag.sh "${app}")"
fi
host="${APP_INGRESS_HOST:-$(env_host "${app}" "${env}")}"

# The namespace (with its DEV/PRD node rule) is created by onboarding, which the homelab repo owns (its
# scripts/onboard-app.sh, driven by its homelab_apps list), never here: the pipeline's deployer can't create or
# change namespaces, and "kubectl apply" fails if it's missing.

shopt -s nullglob
files=("${dir}"/[0-9][0-9]-*.yaml)
[ "${#files[@]}" -gt 0 ] || { echo "No numbered manifests (NN-name.yaml) in ${dir}" >&2; exit 1; }

echo "Deploying ${app} to ${env} (namespace ${ns})${image:+ with ${image}}"
for f in "${files[@]}"; do
  case "${f}" in *ingress*) if [ "${SKIP_INGRESS:-0}" = "1" ]; then echo "skip ${f}"; continue; fi ;; esac
  sed -e "s|APP_IMAGE|${image}|g" -e "s|APP_INGRESS_HOST|${host}|g" -e "s|APP_ENV|${env}|g" "${f}" \
    | kubectl apply -n "${ns}" -f -
done

for kind in deployment statefulset; do
  for obj in $(kubectl -n "${ns}" get "${kind}" -o name 2>/dev/null); do
    kubectl -n "${ns}" rollout status "${obj}" --timeout=180s
  done
done
echo "Deployed ${app} to ${env}. Ingress host (if the app has one): ${host}"
