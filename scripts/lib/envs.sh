# shellcheck shell=bash
# DEV / PRD environments: where each one runs and how it is reached. Sourced by deploy.sh, ci-apps.sh, hpa-demo.sh.
#
#   env      nodes   app address (nip.io turns the IP inside the name into that IP)
#   dev      dev01   <app>.192.168.0.104.nip.io
#   prd      prd01   <app>.192.168.0.103.nip.io
#
# Kubernetes enforces the node part: each <app>-<env> namespace carries a node-selector annotation
# (set by the homelab repo's onboarding) and the API server's PodNodeSelector plugin applies it to every pod.

env_check() { case "${1:-}" in dev|prd) ;; *) echo "ENV must be dev or prd, got '${1:-}'" >&2; return 1 ;; esac; }

env_node_ip() {
  case "$1" in
    dev) echo "192.168.0.104" ;;
    prd) echo "192.168.0.103" ;;
  esac
}

# env_host APP ENV -> the app's Ingress host name in that environment
env_host() { echo "$1.$(env_node_ip "$2").nip.io"; }
