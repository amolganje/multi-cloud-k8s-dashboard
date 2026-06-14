"""
Configuration for RGS OCP Dashboard (Username/Password Auth variant).
Authenticates to OCP clusters via OAuth token exchange using user credentials.
"""
import os
import json

# ---------------------------------------------------------------------------
# Mode: mock vs live
# ---------------------------------------------------------------------------
MOCK_MODE = os.environ.get("MOCK_MODE", "true").lower() == "true"

# ---------------------------------------------------------------------------
# OCP Authentication — username / password
# Set OCP_USERNAME and OCP_PASSWORD in credentials.env (single source of truth).
# ---------------------------------------------------------------------------
OCP_USERNAME = os.environ.get("OCP_USERNAME", "")
OCP_PASSWORD = os.environ.get("OCP_PASSWORD", "")
OCP_TOKEN_TTL = int(os.environ.get("OCP_TOKEN_TTL", "600"))

# ---------------------------------------------------------------------------
# AWS Authentication — access key / secret key (for EKS clusters)
# Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in credentials.env.
# ---------------------------------------------------------------------------
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
AWS_TOKEN_TTL = int(os.environ.get("AWS_TOKEN_TTL", "600"))

# ---------------------------------------------------------------------------
# Cluster definitions
# ---------------------------------------------------------------------------
# JSON map of cluster_id -> {full_name, console_url, api_url, region, provider}
# The api_url is the K8s API endpoint. OAuth tokens are obtained
# automatically using OCP_USERNAME/OCP_PASSWORD.
#
# Example CLUSTERS_CONFIG env var:
# {
#   "dc01": {
#     "full_name": "prodocpcluster401",
#     "console_url": "https://console-openshift-console.apps.prodocpcluster401.example.com/",
#     "api_url": "https://api.prodocpcluster401.example.com:6443",
#     "region": "US - East",
#     "provider": "VMware vSphere",
#     "crd_namespace": "ms360-platform-crd"
#   }
# }
_clusters_raw = os.environ.get("CLUSTERS_CONFIG", "")
try:
    CLUSTERS_CONFIG = json.loads(_clusters_raw) if _clusters_raw else {}
except json.JSONDecodeError:
    CLUSTERS_CONFIG = {}

# ---------------------------------------------------------------------------
# Namespace discovery
# ---------------------------------------------------------------------------
# Namespace naming convention: rgs-<cluster_short>-<env_id>-<suffix>
NAMESPACE_SUFFIXES = ["runtime", "authoring", "backingservices"]
# Legacy single-cluster prefix (used as fallback if CLUSTERS_CONFIG is empty)
NAMESPACE_PREFIX = os.environ.get("NAMESPACE_PREFIX", "rgs")

# ---------------------------------------------------------------------------
# Sanity thresholds
# ---------------------------------------------------------------------------
SANITY_PASS_THRESHOLD = float(os.environ.get("SANITY_PASS_THRESHOLD", "95.0"))

# ---------------------------------------------------------------------------
# ConfigMap names (must exist in each environment namespace)
# ---------------------------------------------------------------------------
# Sanity test results (in runtime namespace)
SANITY_CONFIGMAP_NAME = os.environ.get("SANITY_CONFIGMAP_NAME", "sanity-results")

# Jenkins deployment info (in each namespace: runtime, authoring, backingservices)
DEPLOYMENT_CONFIGMAP_NAME = os.environ.get("DEPLOYMENT_CONFIGMAP_NAME", "deployment-info")

# Environment metadata: branch, owner, etc. (in runtime namespace)
ENV_META_CONFIGMAP_NAME = os.environ.get("ENV_META_CONFIGMAP_NAME", "env-metadata")

# Catalog data files info (in runtime namespace)
CATALOG_DATA_CONFIGMAP_NAME = os.environ.get("CATALOG_DATA_CONFIGMAP_NAME", "catalog-data-files")

# Ingress/route credentials (in runtime namespace)
INGRESS_CREDS_CONFIGMAP_NAME = os.environ.get("INGRESS_CREDS_CONFIGMAP_NAME", "ingress-credentials")

# Product HF versions (in runtime namespace)
PRODUCT_VERSIONS_CONFIGMAP_NAME = os.environ.get("PRODUCT_VERSIONS_CONFIGMAP_NAME", "product-versions")

# ---------------------------------------------------------------------------
# Quick links (top bar)
# ---------------------------------------------------------------------------
# Quick links: either a JSON object with named sections (new format)
# or a flat JSON array of {label, url, icon?} (legacy format).
_quick_links_raw = os.environ.get("QUICK_LINKS", "")
try:
    QUICK_LINKS = json.loads(_quick_links_raw) if _quick_links_raw else {}
except json.JSONDecodeError:
    QUICK_LINKS = {}

# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------
FLASK_HOST = os.environ.get("FLASK_HOST", "0.0.0.0")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "8080"))
FLASK_DEBUG = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
