# Multi-Cloud Kubernetes Dashboard

A production-grade, real-time operations dashboard for managing **OpenShift (OCP)** and **AWS EKS** Kubernetes clusters from a single pane of glass. Built with Python/Flask backend and a modern dark-themed JavaScript frontend.

![Clusters Overview](docs/screenshots/01-clusters-overview.png)

## Features

### Multi-Cloud Cluster Management
- **Unified view** of OpenShift 4.x and AWS EKS clusters with health status, node counts, and version info
- **Auto-discovery** of EKS clusters via AWS API — no manual registration needed
- **Node role classification** — Masters, Workers, Application, Infra, Couchbase, Elasticsearch nodes with smart abbreviations and aggregated counts

### Environment Lifecycle Tracking
- Track **environments across clusters** with drop versions, branches, owners, and deployment status
- **Product version matrix** per namespace (Runtime / Authoring / Backing Services) with mismatch detection
- **Sanity test results** with pass rates, triggered-by info, and Jenkins build links
- **Master vs Regular** environment badges

### Service Catalog & Quick Links
- **Service URL directory** organized by cluster and grouped by Runtime, Authoring, and Backing Services
- **Platform tools** quick-link panel (Jenkins, Nexus, BitBucket, ArgoCD, etc.)
- Exportable tables (CSV)

### CRD / Prerequisites Comparison
- **Cross-cluster Helm release comparison** matrix for platform CRDs and prerequisites
- Version drift detection with visual indicators

### UI / UX
- Dark theme with modern, responsive design
- Provider switcher (All / OpenShift / AWS EKS) with persistent state
- Searchable, sortable, column-resizable tables
- Comfortable / Compact density toggle
- Expandable cluster detail cards with environment + node drill-down
- Export to CSV on every table

---

## Screenshots

### Clusters Overview
All clusters at a glance — status, version, node breakdown, environment count, and drop versions.

![Clusters Overview](docs/screenshots/01-clusters-overview.png)

### Environments Table
Cross-cluster environment listing with drop versions, owners, sanity pass rates, and inline product versions.

![Environments](docs/screenshots/02-environments-table.png)

### Cluster Detail — OpenShift
Deep-dive into an OCP cluster: environments, node list with CPU/memory metrics and role badges.

![OCP Detail](docs/screenshots/03-cluster-detail-ocp.png)

### Cluster Detail — AWS EKS
EKS cluster with application, infra, couchbase, and elasticsearch node groups.

![EKS Detail](docs/screenshots/04-cluster-detail-eks.png)

### Service URLs — EKS
Per-cluster service catalog grouped by namespace role (Runtime, Authoring, Backing Services).

![URLs EKS](docs/screenshots/05-urls-eks-services.png)

### Platform Tools
Quick-access panel for CI/CD pipelines, registries, and cluster management tools.

![Platform Tools](docs/screenshots/06-urls-platform-tools.png)

### Environment Detail
Full environment drill-down: drop version, branch, owner, sanity results, product versions per namespace, catalog data, Jenkins deployments, ingress routes, and pod health.

![Env Detail](docs/screenshots/07-env-detail.png)

### Product Versions — Expanded
Inline version columns for every product across RT/AU/BS namespaces with HF (hotfix) badges.

![Versions Expanded](docs/screenshots/08-env-versions-expanded.png)

### Product Versions — Scrolled
Additional product columns (OC, OH, Care, MASS, CSR, Catalog, Backoffice) visible on scroll.

![Versions Scrolled](docs/screenshots/09-env-versions-scrolled.png)

### CRD / Prerequisites Matrix
Helm release comparison across all clusters — version, revision, and deployment status.

![CRDs](docs/screenshots/10-crds-comparison.png)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                            │
│   dashboard.js  ·  dashboard.css  ·  dark theme  ·  localStorage │
└──────────────────────────┬──────────────────────────────────────┘
                           │  REST API (JSON)
┌──────────────────────────▼──────────────────────────────────────┐
│                    Flask Backend (app.py)                        │
│   /api/clusters  ·  /api/environments  ·  /api/env/<dc>/<env>   │
│   /api/services  ·  /api/quick-links   ·  /api/crd-releases     │
└───────┬─────────────────────────────────────────────┬───────────┘
        │                                             │
┌───────▼───────────┐                       ┌─────────▼───────────┐
│   k8s_client.py   │                       │   aws_client.py     │
│   OCP OAuth +     │                       │   STS token gen     │
│   K8s API calls   │                       │   boto3 / botocore  │
│   (multi-thread)  │                       │   EKS auto-discover │
└───────┬───────────┘                       └─────────┬───────────┘
        │                                             │
┌───────▼───────────┐                       ┌─────────▼───────────┐
│  OCP Clusters     │                       │  AWS EKS Clusters   │
│  :6443 (OAuth)    │                       │  :443 (STS)         │
└───────────────────┘                       └─────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JavaScript (ES6+), CSS3 with CSS Variables, HTML5 |
| **Backend** | Python 3.9+, Flask, Gunicorn |
| **Kubernetes** | kubernetes-client/python, OpenShift OAuth, AWS STS |
| **AWS** | boto3, botocore (EKS describe-cluster, list-clusters) |
| **Deployment** | Docker (multi-stage build), OpenShift Route, systemd (bare metal) |
| **Data** | In-memory cache with configurable TTL, SQLite history (optional) |

---

## Project Structure

```
multi-cloud-k8s-dashboard/
├── app.py                  # Flask application & REST API routes
├── k8s_client.py           # Kubernetes client — OCP + EKS data fetching
├── aws_client.py           # AWS STS token generation for EKS auth
├── config.py               # Environment variable configuration
├── mock_data.py            # Realistic mock data for demo/dev mode
├── requirements.txt        # Python dependencies
├── Dockerfile              # Multi-stage Docker build
├── .dockerignore
├── static/
│   ├── js/dashboard.js     # Frontend SPA logic
│   └── css/dashboard.css   # Dark theme styles
├── templates/
│   └── dashboard.html      # Single HTML template (Jinja2)
├── k8s/
│   ├── deployment.yaml     # K8s Deployment, Service, Route manifests
│   └── dashboard-config.yaml  # ConfigMap with cluster definitions
├── deploy/
│   └── rogers-dashboard.service  # systemd unit for bare-metal RHEL
├── start.sh                # Bare-metal startup script
└── docs/
    └── screenshots/        # Dashboard screenshots
```

---

## Quick Start

### Demo Mode (No Cluster Access Needed)

```bash
# Clone the repo
git clone https://github.com/amolganje/multi-cloud-k8s-dashboard.git
cd multi-cloud-k8s-dashboard

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run in mock mode
export MOCK_MODE=true
python app.py
```

Open [http://localhost:8080](http://localhost:8080) to see the dashboard with realistic mock data.

### Production (OpenShift)

```bash
# Build & push the image
docker build -t <your-registry>/rogers-dashboard:latest .
docker push <your-registry>/rogers-dashboard:latest

# Create namespace, secret, configmap, and deploy
oc new-project rogers-dashboard
oc create secret generic rogers-dashboard-cred \
  --from-literal=OCP_USERNAME=<svc-account> \
  --from-literal=OCP_PASSWORD=<password> \
  --from-literal=AWS_ACCESS_KEY_ID=<key> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<secret> \
  -n rogers-dashboard

oc apply -f k8s/dashboard-config.yaml -n rogers-dashboard
oc apply -f k8s/deployment.yaml -n rogers-dashboard
```

See [DEPLOY.md](DEPLOY.md) for bare-metal (RHEL + systemd) deployment instructions.

---

## Configuration

All configuration is via environment variables or the Kubernetes ConfigMap:

| Variable | Description | Default |
|----------|-------------|---------|
| `MOCK_MODE` | Use mock data (no cluster access) | `false` |
| `CLUSTERS_CONFIG` | JSON map of OCP clusters | — |
| `QUICK_LINKS` | JSON map of quick-link groups | — |
| `AWS_REGION` | AWS region for EKS discovery | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key | — |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | — |
| `HTTP_PROXY` / `HTTPS_PROXY` | Outbound proxy for AWS | — |
| `OCP_USERNAME` / `OCP_PASSWORD` | OCP service account credentials | — |

---

## Key Design Decisions

- **Single-page application** — No React/Vue build step; vanilla JS keeps the footprint tiny and the deploy simple
- **Multi-threaded K8s calls** — `ThreadPoolExecutor` queries all clusters in parallel for sub-second refresh
- **In-memory cache** — Configurable TTL avoids hammering cluster APIs while keeping data fresh
- **EKS auto-discovery** — `list_clusters()` + `describe_cluster()` eliminates manual EKS registration
- **Mock mode** — Full-featured demo with realistic data for development and showcasing without cluster access

---

## License

MIT
