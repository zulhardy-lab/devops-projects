#!/usr/bin/env bash
# Load-balancing + autoscaling demo. Works on any Kubernetes cluster that has metrics-server.
#
#   apps/hpa-demo/hpa-demo.sh deploy       deploy the app, Service, (optional) Ingress and autoscaler to hpa-demo-<env>
#                                                (created for you on your own cluster; on the author's homelab it comes from onboarding)
#   apps/hpa-demo/hpa-demo.sh test         send 10 requests from inside the cluster; shows which pod answered each one
#   apps/hpa-demo/hpa-demo.sh load-start   start the load generator (pushes CPU up)
#   apps/hpa-demo/hpa-demo.sh watch        watch the autoscaler and pods (Ctrl+C to stop watching)
#   apps/hpa-demo/hpa-demo.sh load-stop    stop the load generator (autoscaler scales back down)
#   apps/hpa-demo/hpa-demo.sh status       show everything in the demo's namespace
#   apps/hpa-demo/hpa-demo.sh delete       remove the whole demo
#
# Optional settings (environment variables):
#   HPA_DEMO_ENV      dev (default) or prd: which namespace to work in (hpa-demo-dev / hpa-demo-prd)
# Passed on to scripts/deploy.sh:
#   APP_IMAGE         image to deploy (default: the image built by this repo's pipeline for the current commit)
#   APP_INGRESS_HOST  host name for the Ingress (default on the author's homelab: hpa-demo.192.168.0.104.nip.io
#                     for dev, hpa-demo.192.168.0.103.nip.io for prd; see scripts/lib/envs.sh)
#   SKIP_INGRESS=1    don't create the Ingress (for clusters without Traefik, e.g. minikube, kind)
#
# On the author's homelab, deploys happen automatically after merge (.github/workflows/apps.yml), once the app is
# onboarded by the homelab repo (zulhardy-lab/homelab, list homelab_apps).
set -euo pipefail
cd "$(dirname "$0")/../.."

env="${HPA_DEMO_ENV:-dev}"
ns="hpa-demo-${env}"
k8s=apps/hpa-demo/k8s
# busybox:1.37 pinned by digest; same image as the load generator
busybox="busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

case "${1:-}" in
  deploy)
    # On your own cluster the namespace doesn't exist yet: create it (plain, no DEV/PRD node rule).
    # On the author's homelab it was created by onboarding and is left as it is.
    kubectl get namespace "${ns}" >/dev/null 2>&1 || kubectl create namespace "${ns}"
    # The dashboard's read-only account. On the author's homelab, onboarding creates it; elsewhere, create it here.
    if ! kubectl get namespace "${ns}" -o jsonpath='{.metadata.labels.homelab\.zulhardy/app}' 2>/dev/null | grep -q .; then
      kubectl apply -n "${ns}" -f "${k8s}/rbac-app-reader.yaml"
    fi
    scripts/deploy.sh hpa-demo "${env}"
    ;;
  test)
    # Runs a short-lived pod inside the cluster, so it works without an Ingress or DNS.
    kubectl -n "${ns}" run "hpa-demo-test-$$" --rm -i --restart=Never --quiet \
      --image="${busybox}" \
      --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"t","image":"'"${busybox}"'","command":["sh","-c","for i in 1 2 3 4 5 6 7 8 9 10; do wget -q -O- http://hpa-demo/; done"],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}}]}}'
    ;;
  load-start)
    kubectl apply -n "${ns}" -f "${k8s}/load-generator.yaml"
    ;;
  watch)
    if command -v watch >/dev/null; then
      watch -n 5 "kubectl -n ${ns} get hpa hpa-demo; echo; kubectl -n ${ns} get pods -o wide; echo; kubectl -n ${ns} top pods 2>/dev/null"
    else
      kubectl -n "${ns}" get hpa hpa-demo --watch
    fi
    ;;
  load-stop)
    kubectl delete -n "${ns}" -f "${k8s}/load-generator.yaml" --ignore-not-found
    ;;
  status)
    kubectl -n "${ns}" get all,ingress,hpa
    ;;
  delete)
    if kubectl get namespace "${ns}" -o jsonpath='{.metadata.labels.homelab\.zulhardy/app}' 2>/dev/null | grep -q .; then
      echo "${ns} is managed by the homelab pipeline (onboarded). Not deleting it from here." >&2
      echo "Removing an onboarded app is a manual step: see docs/AUTOMATION.md in the homelab repo." >&2
      exit 1
    fi
    kubectl delete namespace "${ns}" --ignore-not-found
    ;;
  *)
    sed -n '2,22p' "$0"
    exit 1
    ;;
esac
