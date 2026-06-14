#!/bin/bash
# =============================================================================
# Dashboard - Single-command startup (OCP + AWS EKS)
# Usage:  ./start.sh
#
# Edit credentials.env FIRST to set OCP and AWS credentials.
# =============================================================================

set -e
cd "$(dirname "$0")"

# --- Load credentials (single source of truth) -------------------------------
if [ ! -f credentials.env ]; then
    echo "ERROR: credentials.env not found. Copy from credentials.env.example and fill in." >&2
    exit 1
fi
# shellcheck disable=SC1091
source credentials.env

# --- Mode --------------------------------------------------------------------
export MOCK_MODE=false
export FLASK_DEBUG=false

# Token cache TTL (seconds) - OCP OAuth and EKS STS tokens
export OCP_TOKEN_TTL=600
export AWS_TOKEN_TTL=600

# --- History DB --------------------------------------------------------------
# Writable location for the SQLite history DB. systemd sets this to the
# service's data dir (which is the only writable path under ProtectSystem=strict).
# Falls back to ./history.db for local/dev runs.
export HISTORY_DB_PATH="${HISTORY_DB_PATH:-$(pwd)/history.db}"
mkdir -p "$(dirname "$HISTORY_DB_PATH")"

# --- Clusters ----------------------------------------------------------------
# Only OCP clusters need to be listed here.
# AWS EKS clusters are auto-discovered at startup using the AWS credentials
# (eks:ListClusters + eks:DescribeCluster). Every EKS cluster visible in the
# configured AWS_REGION is added automatically — no manual entries needed.
#
# Each OCP entry has provider="ocp" (default) and:
#   - full_name, api_url, console_url, region
export CLUSTERS_CONFIG='{
  "dc01": {
    "short_name": "ocp-401",
    "full_name": "prodocpcluster401",
    "console_url": "https://console-openshift-console.apps.prodocpcluster401.example.com/",
    "api_url": "https://api.prodocpcluster401.example.com:6443",
    "region": "US - East",
    "provider": "VMware vSphere"
  },
  "dc02": {
    "short_name": "ocp-402",
    "full_name": "prodocpcluster402",
    "console_url": "https://console-openshift-console.apps.prodocpcluster402.example.com/",
    "api_url": "https://api.prodocpcluster402.example.com:6443",
    "region": "US - East",
    "provider": "VMware vSphere"
  },
  "dc03": {
    "short_name": "ocp-403",
    "full_name": "prodocpcluster403",
    "console_url": "https://console-openshift-console.apps.prodocpcluster403.example.com/",
    "api_url": "https://api.prodocpcluster403.example.com:6443",
    "region": "US - West",
    "provider": "VMware vSphere"
  }
}'

# --- Quick Links -------------------------------------------------------------
export QUICK_LINKS='{
  "dvc": {
    "label": "DevOps Tools",
    "icon": "wrench",
    "links": [
      {"label": "Jenkins", "url": "https://jenkins.example.com", "icon": "jenkins"},
      {"label": "Git Repository", "url": "https://git.example.com", "icon": "git"},
      {"label": "Artifact Repository", "url": "https://nexus.example.com", "icon": "package"}
    ]
  },
  "aws": {
    "label": "AWS Tools",
    "icon": "aws",
    "links": [
      {"label": "AWS Jenkins", "url": "https://jenkins.aws.example.com", "icon": "jenkins"},
      {"label": "AWS Nexus", "url": "https://nexus.aws.example.com", "icon": "package"},
      {"label": "AWS Console", "url": "https://console.aws.example.com", "icon": "aws"}
    ]
  }
}'

# --- Start -------------------------------------------------------------------
# Use venv gunicorn if available (RHEL deployment), else fall back to PATH
GUNICORN="/opt/rogers-dashboard/venv/bin/gunicorn"
[ ! -x "$GUNICORN" ] && GUNICORN="gunicorn"

PORT="${FLASK_PORT:-8080}"
echo "Starting Dashboard on http://0.0.0.0:${PORT}"
exec $GUNICORN --bind "0.0.0.0:${PORT}" --workers 2 --threads 4 --timeout 120 \
    --access-logfile - --error-logfile - app:app
