# hpa-demo: load balancing and autoscaling on Kubernetes

A small, self-contained demo you can run on **any Kubernetes cluster** in about 10 minutes.
It shows two things that cloud applications are usually asked to do:

1. **Load balancing:** spread incoming requests across several copies (pods) of an app.
2. **Autoscaling:** add pods automatically when traffic is high, and remove them when it drops.

The app is a tiny Python web server. Every request makes it do some CPU work, and it replies with the
name of the pod that answered, so you can *see* both the load balancing and the scaling happen.

**Open it in a browser and you get a live dashboard** (on the author's homelab: `http://hpa-demo.192.168.0.104.nip.io`
for DEV):

- a **cluster map**: the Service in the middle, each node as a hexagon, each pod as a dot (amber above the CPU target,
  teal at or below it, dashed while starting);
- **Generate load**: buttons for Off, 50%, 100%, 200% and 300%, and a slider from 0% to 300%. The percentage is how
  much CPU this page asks for, as a share of one pod's 100m: 100% means one pod's worth, so expect about 2 pods at
  50% each; 200% means about 4. Above 250%, 5 pods aren't enough and CPU stays above the target. The load only runs
  while the page is open, and every open page adds its own;
- pods over time, CPU per pod, average CPU against the 50% target, the requests this page sent and which pods
  answered them, and what the autoscaler is doing.

The page reads its data from the Kubernetes API with a **read-only** account (`app-reader`: its own namespace's pods,
autoscaler and pod CPU; no Secrets, no writes). `curl`, `wget` and the load generator still get the plain-text
`OK from <pod>` reply.

| Path | What it does |
|---|---|
| `/` | Browsers: the dashboard. Anything else: CPU work, then `OK from <pod>` |
| `/burn` | About 20 ms of CPU, then `{"pod": "<name>"}`. The dashboard's load uses this |
| `/api/state` | The pods, their CPU and the autoscaler, as JSON (`"available": false` outside a cluster) |
| `/healthz` | `ok`, for Kubernetes' health checks |

| Requirement | Kubernetes piece | File |
|---|---|---|
| Load balancing inside the cluster | Service | [`k8s/20-service.yaml`](k8s/20-service.yaml) |
| Load balancing from outside (optional) | Ingress (Traefik, built into k3s) | [`k8s/30-ingress.yaml`](k8s/30-ingress.yaml) |
| Scale out when busy, scale in when quiet | HorizontalPodAutoscaler: 1 to 5 pods, target 50% CPU | [`k8s/40-hpa.yaml`](k8s/40-hpa.yaml) |
| Something to scale | Deployment of the demo app | [`k8s/10-deployment.yaml`](k8s/10-deployment.yaml) |
| Traffic to trigger scaling | Load generator (2 pods sending requests in a loop) | [`k8s/load-generator.yaml`](k8s/load-generator.yaml) |

## How it fits together

```mermaid
flowchart LR
    LG[load-generator pods] -->|HTTP requests| SVC[Service hpa-demo]
    USER[Browser / curl] -.->|optional| ING[Ingress / Traefik] -.-> SVC
    SVC --> P1[pod 1]
    SVC --> P2[pod 2]
    SVC --> P3[pod ...up to 5]
    MS[metrics-server] -->|CPU per pod| HPA[HorizontalPodAutoscaler]
    HPA -->|sets number of pods| DEP[Deployment hpa-demo]
    DEP --> P1 & P2 & P3
```

1. The **load generator** sends requests to the **Service**.
2. The Service spreads them across all ready pods (load balancing).
3. **metrics-server** measures each pod's CPU. The app asks for 100m CPU (a tenth of a core).
4. When average CPU goes above **50%** of that, the **HPA** adds pods, up to 5.
5. When you stop the load, CPU drops. After a 60-second wait the HPA removes pods again, down to 1.

## What you need

- A Kubernetes cluster with **metrics-server** running. Some options:
  - **k3s**: metrics-server and Traefik are included. This is what the author used.
  - **minikube**: run `minikube addons enable metrics-server` first.
  - **kind**, **Docker Desktop** and others: install metrics-server yourself.
- `kubectl` connected to that cluster. Check with `kubectl top nodes`: if it prints CPU and memory, you're ready.
- `git` and `bash`.
- About 1.5 CPU cores free in the cluster while the load test runs.

You do **not** need to build anything. The app image is public:
`ghcr.io/zulhardy-lab/hpa-demo`, built by this repo's pipeline.

## Run it

```bash
git clone https://github.com/zulhardy-lab/devops-projects.git
cd devops-projects
```

**1. Deploy**

```bash
SKIP_INGRESS=1 scripts/hpa-demo.sh deploy
```

Leave out `SKIP_INGRESS=1` if your cluster has Traefik (k3s) and you want to open the app in a browser.
Then also set `APP_INGRESS_HOST`, for example `APP_INGRESS_HOST=hpa-demo.<your-node-ip>.nip.io`
([nip.io](https://nip.io) turns that name into the IP inside it).

Expected: `deployment "hpa-demo" successfully rolled out`

**2. Check it answers**

```bash
scripts/hpa-demo.sh test
```

This runs a short-lived pod inside the cluster that sends 10 requests. With 1 pod, every reply has the same name:

```
OK from hpa-demo-5676d75f99-s52jt
OK from hpa-demo-5676d75f99-s52jt
...
```

**3. Start the load and watch it scale out**

```bash
scripts/hpa-demo.sh load-start
scripts/hpa-demo.sh watch
```

Within 1 to 2 minutes, `TARGETS` climbs well above 50% and pods are added until there are 5.
Press `Ctrl+C` to stop watching. The load keeps running.

**4. See the load balancing**

```bash
scripts/hpa-demo.sh test
```

Now the replies come from **different pods**.

**5. Stop the load and watch it scale back in**

```bash
scripts/hpa-demo.sh load-stop
scripts/hpa-demo.sh watch
```

CPU drops to near 0%. After about a minute the extra pods show `Terminating`, and it goes back to 1 pod.

**6. Clean up**

```bash
scripts/hpa-demo.sh delete
```

This removes the whole `hpa-demo-dev` namespace and everything in it. (On the author's homelab it refuses:
there the namespace is managed by the pipeline.)

The scripts work in namespace `hpa-demo-dev` by default. Set `HPA_DEMO_ENV=prd` to use `hpa-demo-prd` instead.

## What it looked like on the author's homelab

A k3s cluster, 4 CPU / 8 GB per node. The screenshots are from the earlier 2-node setup (docker01 and linux01,
namespace `hpa-demo`); the homelab now runs DEV on dev01 and PRD on prd01, in `hpa-demo-dev` / `hpa-demo-prd`.

**Under load:** CPU at 501% of target, the HPA has scaled from 1 to 5 pods, spread across both nodes.

![Scaled out to 5 pods under load](docs/1-scaled-out-under-load.png)

**Load stopped:** CPU at 1%, the extra pods are terminating.

![Scaling in](docs/2-scaling-in.png)

**Back to 1 pod**, about 4 minutes after the test started.

![Back to one pod](docs/3-back-to-one-pod.png)

## Things you can change

| What | Where | Default |
|---|---|---|
| Min / max pods | `minReplicas`, `maxReplicas` in [`k8s/40-hpa.yaml`](k8s/40-hpa.yaml) | 1 / 5 |
| CPU target | `averageUtilization` in [`k8s/40-hpa.yaml`](k8s/40-hpa.yaml) | 50% |
| How fast it scales back in | `stabilizationWindowSeconds` in [`k8s/40-hpa.yaml`](k8s/40-hpa.yaml) | 60s (Kubernetes default is 300s) |
| CPU work per request | `CPU_WORK_ITERATIONS` env var on the Deployment | 1000000 |
| Amount of load | `replicas` in [`k8s/load-generator.yaml`](k8s/load-generator.yaml) | 2 |

## Troubleshooting

| You see | Likely cause | What to do |
|---|---|---|
| `TARGETS` shows `<unknown>` | metrics-server not installed or still starting | Check `kubectl top pods -n hpa-demo-dev`. Wait a minute, or install metrics-server. |
| Pods stuck in `ImagePullBackOff` | Cluster can't reach `ghcr.io` | Check the nodes have internet access |
| Pods stay `Terminating` for about 30 seconds | The demo app doesn't handle the stop signal (SIGTERM), so Kubernetes waits for its 30s grace period | Harmless in this demo |
| `scripts/image-tag.sh` says no commit found | The repo was cloned with `--depth 1` | Clone normally (full history), or set `APP_IMAGE` yourself |
| Pods never go above 1 | Not enough load, or the cluster is out of CPU | Raise `replicas` in the load generator; check `kubectl describe hpa -n hpa-demo-dev` |

## How it's built and deployed (on the author's homelab)

hpa-demo uses this repo's generic apps pipeline, [`.github/workflows/apps.yml`](../../.github/workflows/apps.yml),
like any app under `apps/`. Before it can deploy, the homelab must have **onboarded** it: that's done in the
[homelab repo](https://github.com/zulhardy-lab/homelab) (its `homelab_apps` list), not here.

Merging a change under `apps/hpa-demo/` into `main`:

1. **Test and scan** (GitHub-hosted runners): unit tests in [`tests/test_app.py`](tests/test_app.py), Trivy scan of the repo.
2. **Build** (GitHub-hosted runner): [`scripts/build-image.sh`](../../scripts/build-image.sh) builds
   `ghcr.io/zulhardy-lab/hpa-demo:sha-<last commit that changed apps/hpa-demo/app>`, runs
   [`tests/integration.sh`](tests/integration.sh) against the container, scans the image, and only then pushes it.
3. **DEV** (self-hosted runner on ops01, no approval): a 10-minute token that only works in `hpa-demo-dev`;
   [`scripts/deploy.sh hpa-demo dev`](../../scripts/deploy.sh), rollout check, then `integration.sh` again against
   `http://hpa-demo.192.168.0.104.nip.io`. The pods run on dev01.
4. **PRD** (approval required): the same image, a token that only works in `hpa-demo-prd`, pods on prd01,
   smoke test against `http://hpa-demo.192.168.0.103.nip.io`.

Only the numbered manifests in `k8s/` are deployed; `load-generator.yaml` isn't, so the load test stays manual.
Who may deploy, and with which permissions, is in the homelab repo's
[`app-deployer-rbac.yaml.tmpl`](https://github.com/zulhardy-lab/homelab/blob/main/ansible/files/k8s/app-deployer-rbac.yaml.tmpl),
applied when the app is onboarded. The same template creates the dashboard's read-only `app-reader` account; on your
own cluster, `scripts/hpa-demo.sh deploy` creates it from [`k8s/rbac-app-reader.yaml`](k8s/rbac-app-reader.yaml). How it all works: [README.md](../../README.md) here, and the homelab's
[docs/AUTOMATION.md](https://github.com/zulhardy-lab/homelab/blob/main/docs/AUTOMATION.md).
You don't need any of this to *try* the demo on your own cluster: `scripts/hpa-demo.sh deploy` uses your own kubeconfig.

## Security choices

- Base images (`python:3.13-slim`, `busybox:1.37`) are **pinned by digest**, so a rebuild can't silently pick up a different image.
- The app runs as a **non-root** user, with a **read-only filesystem**, **no Linux capabilities**, and no privilege escalation.
- The pipeline only gets `contents: read` and `packages: write`, for that one run.
- The dashboard's account is **read-only, in its own namespace only** (pods, autoscaler, pod CPU). The load buttons
  are plain HTTP requests: no Kubernetes write permissions anywhere.
- The page is served with a strict **Content-Security-Policy** (`default-src 'self'`: no inline scripts, no outside
  fonts or scripts), and everything it shows from the server is set as text, never as HTML.
- `/burn` uses a fixed slice of CPU; a request can't ask for more. `/api/state` is cached for a second per pod, so
  many open pages don't flood the Kubernetes API.

## Mapping to Azure

Useful for comparing this homelab demo with an Azure design:

| Here (Kubernetes / k3s) | Azure App Service | Azure Kubernetes Service (AKS) |
|---|---|---|
| Service + Ingress | Built-in load balancing across instances | Service + Azure Load Balancer / Application Gateway |
| HorizontalPodAutoscaler | Autoscale rules (scale out/in on CPU or other metrics) | The same HPA, plus the cluster autoscaler for adding nodes |
| metrics-server | Azure Monitor metrics | metrics-server / Azure Monitor |
