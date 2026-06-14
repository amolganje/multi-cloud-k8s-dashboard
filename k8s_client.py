"""
Kubernetes client for fetching real data from OCP cluster.
Multi-cluster support via CLUSTERS_CONFIG.
Authentication via OCP OAuth username/password token exchange.
"""
import base64
import gzip
import json
import logging
import os
import re
import threading
import time
import urllib3
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs, urlsplit
from kubernetes import client
from config import (
    CLUSTERS_CONFIG, NAMESPACE_SUFFIXES,
    NAMESPACE_PREFIX, SANITY_CONFIGMAP_NAME, SANITY_PASS_THRESHOLD,
    DEPLOYMENT_CONFIGMAP_NAME, ENV_META_CONFIGMAP_NAME,
    CATALOG_DATA_CONFIGMAP_NAME, INGRESS_CREDS_CONFIGMAP_NAME,
    PRODUCT_VERSIONS_CONFIGMAP_NAME,
    OCP_USERNAME, OCP_PASSWORD, OCP_TOKEN_TTL,
)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
requests.packages.urllib3.disable_warnings()

log = logging.getLogger(__name__)

_api_clients = {}
_client_lock = threading.Lock()
_token_cache = {}

# ---------------------------------------------------------------------------
# AWS EKS auto-discovery (background)
# If AWS credentials are present, list all EKS clusters in the configured
# region and merge them into CLUSTERS_CONFIG. Runs in a daemon thread so a
# slow/unreachable AWS endpoint never blocks worker startup (boto calls are
# also timeout-bounded in aws_client). EKS clusters appear in the UI once the
# discovery completes (the frontend polls /api/clusters).
# ---------------------------------------------------------------------------
def _auto_discover_eks():
    try:
        from aws_client import discover_eks_clusters as _discover_eks_clusters
        eks_auto = _discover_eks_clusters()
        for cid, cfg in eks_auto.items():
            if cid not in CLUSTERS_CONFIG:
                CLUSTERS_CONFIG[cid] = cfg
            else:
                for k, v in cfg.items():
                    CLUSTERS_CONFIG[cid].setdefault(k, v)
        if eks_auto:
            log.info("Merged %d auto-discovered EKS cluster(s) into CLUSTERS_CONFIG", len(eks_auto))
    except Exception as e:
        log.warning("EKS auto-discovery skipped: %s", e, exc_info=True)

threading.Thread(target=_auto_discover_eks, name="eks-discovery", daemon=True).start()

# ---------------------------------------------------------------------------
# OCP OAuth token exchange
# ---------------------------------------------------------------------------

def _derive_oauth_url(api_url):
    """Derive the OCP OAuth server URL from the K8s API URL.

    api_url like https://api.cluster.ocp.example.com:6443
    -> oauth  at  https://oauth-openshift.apps.cluster.ocp.example.com
    """
    parsed = urlsplit(api_url)
    host = parsed.hostname or ""
    if host.startswith("api."):
        apps_domain = "apps." + host[4:]
    else:
        apps_domain = host
    return f"https://oauth-openshift.{apps_domain}/oauth/authorize"


def _get_oauth_token(cluster_id):
    """Get a bearer token for a cluster via OCP OAuth, with caching."""
    cached = _token_cache.get(cluster_id)
    if cached and (time.time() - cached["ts"]) < OCP_TOKEN_TTL:
        return cached["token"]

    cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    api_url = cfg.get("api_url", "")
    if not api_url:
        raise RuntimeError(f"No api_url configured for cluster '{cluster_id}'")

    oauth_url = _derive_oauth_url(api_url)
    log.info("Requesting OAuth token for cluster '%s' from %s", cluster_id, oauth_url)

    try:
        resp = requests.get(
            oauth_url,
            params={
                "response_type": "token",
                "client_id": "openshift-challenging-client",
            },
            headers={"X-CSRF-Token": "1"},
            auth=(OCP_USERNAME, OCP_PASSWORD),
            verify=False,
            allow_redirects=False,
            timeout=15,
        )
    except requests.RequestException as e:
        raise RuntimeError(
            f"OAuth request failed for cluster '{cluster_id}' at {oauth_url}: {e}"
        )

    location = resp.headers.get("Location", "")
    if not location or "access_token=" not in location:
        raise RuntimeError(
            f"OAuth token exchange failed for cluster '{cluster_id}'. "
            f"HTTP {resp.status_code}, Location: {location!r}. "
            f"Check OCP_USERNAME/OCP_PASSWORD credentials."
        )

    fragment = location.split("#", 1)[-1] if "#" in location else location.split("?", 1)[-1]
    params = parse_qs(fragment)
    token = params.get("access_token", [None])[0]
    if not token:
        raise RuntimeError(
            f"Could not parse access_token from OAuth redirect for cluster '{cluster_id}'. "
            f"Location header: {location!r}"
        )

    _token_cache[cluster_id] = {"token": token, "ts": time.time()}
    log.info("OAuth token obtained for cluster '%s' (expires in %ds)", cluster_id, OCP_TOKEN_TTL)
    return token


def invalidate_token(cluster_id):
    """Invalidate cached token and API client for a cluster (call on 401)."""
    _token_cache.pop(cluster_id, None)
    with _client_lock:
        _api_clients.pop(cluster_id, None)


# ---------------------------------------------------------------------------
# K8s client init (per-cluster, cached, thread-safe)
# Routes auth by provider: "ocp" (default) -> OAuth user/pass
#                          "aws"            -> STS presigned -> EKS bearer
# ---------------------------------------------------------------------------

_eks_ca_files = {}


def _proxy_for_url(url):
    """Return the proxy URL to use for `url`, honouring HTTP(S)_PROXY / NO_PROXY
    env vars. Returns None when the host matches NO_PROXY (e.g. OCP corp hosts).

    Needed because the kubernetes client does NOT read proxy env vars itself,
    unlike boto3 and requests. EKS API calls go through this.
    """
    proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
             or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy"))
    if not proxy:
        return None
    host = (urlsplit(url).hostname or "").lower()
    no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    for entry in no_proxy.split(","):
        entry = entry.strip().lstrip(".").lower()
        if not entry:
            continue
        if host == entry or host.endswith("." + entry):
            return None
    return proxy


def _provider_of(cluster_id):
    cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    return (cfg.get("provider") or "ocp").lower()


def _build_ocp_client(cluster_id):
    cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    api_url = cfg.get("api_url", "")
    if not api_url:
        raise RuntimeError(f"No api_url configured for OCP cluster '{cluster_id}'")
    token = _get_oauth_token(cluster_id)
    conf = client.Configuration()
    conf.host = api_url
    conf.api_key = {"authorization": f"Bearer {token}"}
    conf.verify_ssl = False
    log.info("Connected to OCP cluster '%s' at %s", cluster_id, api_url)
    return client.ApiClient(configuration=conf)


def _write_eks_ca_file(cluster_id, ca_data_b64):
    """Write base64-encoded EKS CA cert to a temp file and cache the path."""
    import tempfile
    if cluster_id in _eks_ca_files:
        return _eks_ca_files[cluster_id]
    ca_pem = base64.b64decode(ca_data_b64)
    fd, path = tempfile.mkstemp(prefix=f"eks-ca-{cluster_id}-", suffix=".crt")
    with os.fdopen(fd, "wb") as f:
        f.write(ca_pem)
    _eks_ca_files[cluster_id] = path
    return path


def _build_aws_client(cluster_id):
    from aws_client import get_eks_token, describe_eks_cluster
    cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    eks_name = cfg.get("eks_cluster_name") or cfg.get("full_name") or cluster_id
    region = cfg.get("region")

    api_url = cfg.get("api_url")
    ca_data = cfg.get("ca_data")
    if not api_url or not ca_data:
        info = describe_eks_cluster(eks_name, region)
        api_url = api_url or info["endpoint"]
        ca_data = ca_data or info["ca_data"]

    token = get_eks_token(eks_name, region)
    conf = client.Configuration()
    conf.host = api_url
    conf.api_key = {"authorization": f"Bearer {token}"}
    conf.ssl_ca_cert = _write_eks_ca_file(cluster_id, ca_data)
    conf.verify_ssl = True
    proxy = _proxy_for_url(api_url)
    if proxy:
        conf.proxy = proxy
        log.info("EKS cluster '%s' API will be reached via proxy %s", cluster_id, proxy)
    log.info("Connected to EKS cluster '%s' (%s) at %s", cluster_id, eks_name, api_url)
    return client.ApiClient(configuration=conf)


def _token_is_fresh(cluster_id, provider):
    """Check whether the cached token for this cluster is still within TTL."""
    if provider == "ocp":
        cached = _token_cache.get(cluster_id)
        return bool(cached and (time.time() - cached["ts"]) < OCP_TOKEN_TTL)
    if provider == "aws":
        from aws_client import _eks_token_cache, AWS_TOKEN_TTL as _TTL
        cfg = CLUSTERS_CONFIG.get(cluster_id, {})
        eks_name = cfg.get("eks_cluster_name") or cfg.get("full_name") or cluster_id
        region = cfg.get("region")
        from config import AWS_REGION
        key = f"{region or AWS_REGION}/{eks_name}"
        cached = _eks_token_cache.get(key)
        return bool(cached and (time.time() - cached["ts"]) < _TTL)
    return False


def _get_api_client(cluster_id):
    """Return a cached ApiClient for the given cluster, routing by provider."""
    provider = _provider_of(cluster_id)
    if cluster_id in _api_clients and _token_is_fresh(cluster_id, provider):
        return _api_clients[cluster_id]

    with _client_lock:
        if cluster_id in _api_clients and _token_is_fresh(cluster_id, provider):
            return _api_clients[cluster_id]
        _api_clients.pop(cluster_id, None)

        if provider == "aws":
            api_client = _build_aws_client(cluster_id)
        else:
            api_client = _build_ocp_client(cluster_id)

        _api_clients[cluster_id] = api_client
        return api_client


def _core_v1(cluster_id):
    return client.CoreV1Api(api_client=_get_api_client(cluster_id))


def _custom_objects(cluster_id):
    return client.CustomObjectsApi(api_client=_get_api_client(cluster_id))


def _networking_v1(cluster_id):
    return client.NetworkingV1Api(api_client=_get_api_client(cluster_id))


def _fmt_drop(raw):
    raw = str(raw).strip()
    if raw and len(raw) == 4 and raw.isdigit():
        return f"{raw[:2]}.{raw[2:]}"
    return raw


def _extract_drop_from_env_id(env_id):
    """
    Infer the raw 4-digit drop version from the env_id portion of the
    namespace name.

    Master envs:  mst2503         -> 2503
    Regular envs: env8_2503       -> 2503  (description suffix, already handled)
                  env8            -> None  (no drop info in the name)
    """
    if not env_id:
        return None
    m = re.match(r'^mst(\d{4})$', env_id, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r'(\d{4})$', env_id)
    if m:
        candidate = m.group(1)
        prefix = env_id[:m.start()]
        if prefix and not prefix[-1].isdigit():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Resource quantity parsing (cpu / memory)
# ---------------------------------------------------------------------------

def _parse_cpu(val):
    """Convert CPU string to millicores (int). E.g. '250m' -> 250, '1' -> 1000."""
    if not val or val == "N/A":
        return 0
    val = str(val).strip()
    if val.endswith("n"):
        return int(val[:-1]) // 1_000_000
    if val.endswith("u"):
        return int(val[:-1]) // 1_000
    if val.endswith("m"):
        return int(val[:-1])
    try:
        return int(float(val) * 1000)
    except (ValueError, TypeError):
        return 0


def _parse_memory_bytes(val):
    """Convert memory string to bytes (int). E.g. '512Mi' -> 536870912."""
    if not val or val == "N/A":
        return 0
    val = str(val).strip()
    suffixes = [("Ki", 1024), ("Mi", 1024**2), ("Gi", 1024**3), ("Ti", 1024**4),
                ("k", 1000), ("M", 1000**2), ("G", 1000**3), ("T", 1000**4)]
    for suffix, mult in suffixes:
        if val.endswith(suffix):
            try:
                return int(float(val[:-len(suffix)]) * mult)
            except (ValueError, TypeError):
                return 0
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def _get_pod_metrics(cluster_id, namespace):
    """Fetch pod metrics from metrics.k8s.io API. Returns dict: pod_name -> {cpu_m, mem_bytes}."""
    try:
        api = _custom_objects(cluster_id)
        result = api.list_namespaced_custom_object(
            group="metrics.k8s.io", version="v1beta1",
            namespace=namespace, plural="pods"
        )
        metrics = {}
        for item in result.get("items", []):
            pod_name = item["metadata"]["name"]
            cpu_total = 0
            mem_total = 0
            for container in item.get("containers", []):
                usage = container.get("usage", {})
                cpu_total += _parse_cpu(usage.get("cpu", "0"))
                mem_total += _parse_memory_bytes(usage.get("memory", "0"))
            metrics[pod_name] = {"cpu_m": cpu_total, "mem_bytes": mem_total}
        return metrics
    except Exception as e:
        log.warning("Failed to get pod metrics for %s/%s: %s", cluster_id, namespace, e)
        return {}


def _get_node_metrics(cluster_id):
    """Fetch node metrics from metrics.k8s.io API. Returns dict: node_name -> {cpu_m, mem_bytes}."""
    try:
        api = _custom_objects(cluster_id)
        result = api.list_cluster_custom_object(
            group="metrics.k8s.io", version="v1beta1", plural="nodes",
            _request_timeout=10,
        )
        metrics = {}
        for item in result.get("items", []):
            node_name = item["metadata"]["name"]
            usage = item.get("usage", {})
            metrics[node_name] = {
                "cpu_m": _parse_cpu(usage.get("cpu", "0")),
                "mem_bytes": _parse_memory_bytes(usage.get("memory", "0")),
            }
        return metrics
    except Exception as e:
        log.warning("Failed to get node metrics for %s: %s", cluster_id, e)
        return {}


_AZ_SUFFIX_RE = re.compile(r"-[a-z0-9]?[a-z]$")


def _eks_node_group(labels, cluster_prefix=""):
    """Derive a node-group category for an EKS node from its nodegroup label.

    EKS managed node groups are named like
    '<cluster>-elasticsearch-a-nodegroup-...'; this strips the cluster prefix
    and the '-nodegroup...' suffix, then collapses per-AZ variants
    (couchbase-a / couchbase-b / couchbase-c -> 'couchbase') so each functional
    group is counted together. Returns 'worker' when no nodegroup label exists.
    """
    ng = (
        labels.get("eks.amazonaws.com/nodegroup")
        or labels.get("alpha.eksctl.io/nodegroup-name")
        or labels.get("node.kubernetes.io/nodegroup")
        or labels.get("nodegroup")
        or labels.get("karpenter.sh/nodepool")
        or ""
    )
    if not ng:
        return "worker"
    name = ng
    if cluster_prefix and name.startswith(cluster_prefix):
        name = name[len(cluster_prefix):].lstrip("-")
    idx = name.find("-nodegroup")
    if idx != -1:
        name = name[:idx]
    # Collapse a trailing AZ suffix (e.g. '-a', '-1a') into the base group.
    name = _AZ_SUFFIX_RE.sub("", name)
    return name or "worker"


def _ocp_node_role(labels):
    for lbl in labels:
        if lbl.startswith("node-role.kubernetes.io/"):
            r = lbl.split("/", 1)[1] or "worker"
            return "master" if r == "control-plane" else r
    return "worker"


def _node_role(labels, cloud, cluster_prefix=""):
    """Classify a node: EKS by node group, OCP by node-role labels."""
    if cloud == "aws":
        return _eks_node_group(labels, cluster_prefix)
    return _ocp_node_role(labels)


def _build_node_details(cluster_id, node_items):
    """Per-node summary: name, role, k8s version, instance type, zone,
    capacity (cpu_m, mem_bytes) and live usage when metrics-server is up.

    `node_items` is the v1 Node list already fetched by _get_cluster_health
    (so this is zero-extra-cost on the node-list side).
    """
    _cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    _cloud = (_cfg.get("provider") or "ocp").lower()
    _prefix = _cfg.get("eks_cluster_name") or _cfg.get("full_name") or cluster_id
    metrics = _get_node_metrics(cluster_id) if node_items else {}
    rows = []
    for n in node_items or []:
        meta = n.metadata or None
        status = n.status or None
        labels = (meta.labels if meta else {}) or {}
        ni = getattr(status, "node_info", None) if status else None
        capacity = (getattr(status, "capacity", {}) or {}) if status else {}
        allocatable = (getattr(status, "allocatable", {}) or {}) if status else {}

        role = _node_role(labels, _cloud, _prefix)

        ready = "Unknown"
        if status and status.conditions:
            for c in status.conditions:
                if c.type == "Ready":
                    ready = "Ready" if c.status == "True" else "NotReady"
                    break

        used = metrics.get(meta.name if meta else "", {}) if metrics else {}
        rows.append({
            "name": meta.name if meta else "",
            "role": role,
            "k8s_version": _clean_k8s_version((ni.kubelet_version if ni else "") or ""),
            "os_image": (ni.os_image if ni else "") or "",
            "kernel": (ni.kernel_version if ni else "") or "",
            "container_runtime": (ni.container_runtime_version if ni else "") or "",
            "instance_type": (
                labels.get("node.kubernetes.io/instance-type")
                or labels.get("beta.kubernetes.io/instance-type")
                or ""
            ),
            "zone": (
                labels.get("topology.kubernetes.io/zone")
                or labels.get("failure-domain.beta.kubernetes.io/zone")
                or ""
            ),
            "nodegroup": (
                labels.get("eks.amazonaws.com/nodegroup")
                or labels.get("karpenter.sh/nodepool")
                or ""
            ),
            "capacity": {
                "cpu_m": _parse_cpu(capacity.get("cpu", "0")),
                "mem_bytes": _parse_memory_bytes(capacity.get("memory", "0")),
                "pods": int(capacity.get("pods", "0") or 0),
            },
            "allocatable": {
                "cpu_m": _parse_cpu(allocatable.get("cpu", "0")),
                "mem_bytes": _parse_memory_bytes(allocatable.get("memory", "0")),
            },
            "usage": {
                "cpu_m": used.get("cpu_m", 0),
                "mem_bytes": used.get("mem_bytes", 0),
            },
            "status": ready,
        })
    rows.sort(key=lambda r: (r["role"] != "master", r["name"]))
    return rows


# ---------------------------------------------------------------------------
# OCP version & infrastructure detection
# ---------------------------------------------------------------------------

def _clean_k8s_version(version):
    """Normalize a Kubernetes version to its semantic core (major.minor.patch).

    EKS kubelet versions carry a build suffix (e.g. 'v1.34.1-eks-113cf36');
    strip everything after the patch number so the UI shows 'v1.34.1'.
    """
    if not version:
        return ""
    return re.split(r"[-+]", version.strip(), maxsplit=1)[0]


def _get_ocp_version(cluster_id):
    try:
        co = _custom_objects(cluster_id)
        cv = co.get_cluster_custom_object(
            group="config.openshift.io", version="v1",
            plural="clusterversions", name="version",
        )
        version = cv.get("status", {}).get("desired", {}).get("version", "")
        if version:
            return _clean_k8s_version(version)
    except Exception as e:
        log.debug("ClusterVersion API unavailable for %s: %s", cluster_id, e)

    return _kubelet_version(cluster_id)


def _kubelet_version(cluster_id):
    """Read the kubelet version from any one node (empty if cluster has no nodes)."""
    try:
        v1 = _core_v1(cluster_id)
        nodes = v1.list_node(limit=1)
        if nodes.items:
            return _clean_k8s_version(nodes.items[0].status.node_info.kubelet_version or "")
    except Exception as e:
        log.debug("Failed to get kubelet version for %s: %s", cluster_id, e)
    return ""


def _get_eks_version(cluster_id, cfg):
    """Resolve an EKS cluster's Kubernetes version.

    Taken straight from the EKS control-plane API (describe-cluster) — i.e. the
    exact version the AWS/EKS console reports (e.g. '1.34') — so every cluster
    shows a consistent value regardless of how many worker nodes exist. We do
    NOT derive it from node kubelet versions. Falls back to a node's kubelet
    version only if the EKS API is unreachable.
    """
    try:
        from aws_client import describe_eks_cluster
        eks_name = cfg.get("eks_cluster_name") or cfg.get("full_name") or cluster_id
        info = describe_eks_cluster(eks_name, cfg.get("region"))
        eks_ver = (info.get("version") or "").strip().lstrip("v")
        if eks_ver:
            return "v" + eks_ver
    except Exception as e:
        log.warning("EKS describe-cluster version unavailable for %s: %s",
                    cluster_id, e, exc_info=True)

    return _kubelet_version(cluster_id)


def _get_infra_platform(cluster_id):
    _platform_labels = {
        "VSphere": "VMware vSphere", "AWS": "AWS", "Azure": "Microsoft Azure",
        "GCP": "Google Cloud", "BareMetal": "Bare Metal", "OpenStack": "OpenStack",
    }
    try:
        co = _custom_objects(cluster_id)
        infra = co.get_cluster_custom_object(
            group="config.openshift.io", version="v1",
            plural="infrastructures", name="cluster",
        )
        pt = infra.get("status", {}).get("platformStatus", {}).get("type", "")
        return _platform_labels.get(pt, pt)
    except Exception as e:
        log.debug("Infrastructure API unavailable for %s: %s", cluster_id, e)
    return ""


# ---------------------------------------------------------------------------
# Cluster health
# ---------------------------------------------------------------------------

def _get_cluster_health(cluster_id, v1=None):
    """
    Returns (status_string, details_list, node_list).
    node_list is reused by the caller for node counts.
    """
    if v1 is None:
        v1 = _core_v1(cluster_id)

    issues = []
    node_items = []

    try:
        all_nodes = v1.list_node()
        node_items = all_nodes.items
        not_ready = [n.metadata.name for n in node_items
                     if any(c.type == "Ready" and c.status != "True"
                            for c in (n.status.conditions or []))]
        if not_ready:
            issues.append(f"{len(not_ready)} node(s) NotReady")
    except Exception as e:
        issues.append(f"Node check failed: {e}")

    try:
        co = _custom_objects(cluster_id)
        operators = co.list_cluster_custom_object(
            group="config.openshift.io", version="v1", plural="clusteroperators",
        )
        degraded, unavailable = [], []
        for op in operators.get("items", []):
            name = op.get("metadata", {}).get("name", "unknown")
            conds = {c["type"]: c for c in op.get("status", {}).get("conditions", [])}
            if conds.get("Degraded", {}).get("status") == "True":
                degraded.append(name)
            if conds.get("Available", {}).get("status") == "False":
                unavailable.append(name)
        if degraded:
            issues.append(f"{len(degraded)} operator(s) degraded: {', '.join(degraded[:5])}")
        if unavailable:
            issues.append(f"{len(unavailable)} operator(s) unavailable: {', '.join(unavailable[:5])}")
    except Exception as e:
        log.debug("ClusterOperator check unavailable for %s: %s", cluster_id, e)

    if not issues:
        return "Healthy", [], node_items
    return "Degraded", issues, node_items


# ---------------------------------------------------------------------------
# Cluster overview
# ---------------------------------------------------------------------------

_VAULT_NS_CANDIDATES = ("vault", "vault-1", "hashicorp-vault", "fndsec-vault")
_ARGOCD_NS_CANDIDATES = ("openshift-argocd", "argocd", "openshift-gitops")


def _discover_vault_url(cluster_id, configured_url):
    """Return vault URL — either from config or by discovering a route in the vault namespace."""
    if configured_url:
        return configured_url
    try:
        co = _custom_objects(cluster_id)
    except Exception:
        return ""
    for ns in _VAULT_NS_CANDIDATES:
        try:
            routes = co.list_namespaced_custom_object(
                group="route.openshift.io", version="v1",
                namespace=ns, plural="routes",
            )
            for route in routes.get("items", []):
                name = route.get("metadata", {}).get("name", "")
                spec = route.get("spec", {})
                host = spec.get("host", "")
                if not host:
                    continue
                if "vault" in name.lower() and "unsealer" not in name.lower():
                    scheme = "https" if spec.get("tls") else "http"
                    return f"{scheme}://{host}"
            for route in routes.get("items", []):
                spec = route.get("spec", {})
                host = spec.get("host", "")
                if host:
                    scheme = "https" if spec.get("tls") else "http"
                    return f"{scheme}://{host}"
        except Exception:
            continue
    return ""


# Service catalog for AWS EKS clusters.
# Each entry: (key, label, icon, host_regex) — matched against ingress.spec.rules[].host
# Order matters: first match wins.
_AWS_SERVICE_CATALOG = [
    ("headlamp",     "Headlamp (Cluster UI)",  "headlamp",  r"^headlamp\."),
    ("argocd",       "ArgoCD",                 "argocd",    r"^argo-?cd[\w-]*argocd[\w-]*server"),
    ("keycloak",     "Keycloak",               "keycloak",  r"^keycloak[\w-]*"),
    ("apigw_au",     "API Gateway","apigw",     r"^amd-apigw-stack-service-authoring\."),
    ("apigw_rt",     "API Gateway",  "apigw",     r"^amd-apigw-stack-service-runtime\."),
    ("c1_web",       "C1 Web UI",              "c1web",     r"^c1-web-ui[\w-]*"),
    ("c1_dashboard", "C1 Dashboard",           "c1dash",    r"^c1-dashboard[\w-]*"),
    ("orderworkflow","OrderWorkflow",          "workflow",  r"^orderworkflow-orchestrator-service-"),
    ("backoffice",   "BackOffice",             "office",    r"^backoffice-operation-"),
    ("sky",          "Sky Portal",             "sky",       r"^o2aportalui-fe-service-"),
    ("wiremock",     "WireMock",               "mock",      r"^wiremock-service-"),
    ("couchbase",    "Couchbase",              "couchbase", r"couchbase-\d*-(ui|query)?"),
    ("elastic",      "Elasticsearch",          "elastic",   r"(elasticsearch|elastic-enterprise-[\w-]+-es-master)"),
    ("kafkaui",      "Kafka UI",               "kafka",     r"^kafka-ui[\w-]*"),
]

_AWS_SERVICE_NS_CANDIDATES = (
    "headlamp", "argocd", "authoring", "runtime", "backingservices", "catalog"
)

# OCP service catalog. Same MS360 Helm charts → same host-name patterns,
# but exposed via OpenShift Routes and inside `rgs-<env>-<role>` namespaces.
# Plus OCP-specific platform services (Console, Vault) that EKS doesn't have.
_OCP_SERVICE_CATALOG = [
    ("console",      "OpenShift Console",       "openshift", r"^console-openshift-console\."),
    ("vault",        "Vault",                   "vault",     r"^vault\."),
    ("argocd",       "ArgoCD",                  "argocd",    r"argo-?cd[\w-]*argocd[\w-]*server|^argocd-server-"),
    ("keycloak",     "Keycloak",                "keycloak",  r"keycloak[\w-]*"),
    ("apigw_au",     "API Gateway", "apigw",     r"^amd-apigw-stack-service-[\w-]*authoring"),
    ("apigw_rt",     "API Gateway",   "apigw",     r"^amd-apigw-stack-service-[\w-]*runtime"),
    ("c1_web",       "C1 Web UI",               "c1web",     r"^c1-web-ui[\w-]*"),
    ("c1_dashboard", "C1 Dashboard",            "c1dash",    r"^c1-dashboard[\w-]*"),
    ("orderworkflow","OrderWorkflow",           "workflow",  r"^orderworkflow-orchestrator"),
    ("backoffice",   "BackOffice",              "office",    r"^backoffice-operation"),
    ("sky",          "Sky Portal",              "sky",       r"^o2aportalui-fe-service"),
    ("wiremock",     "WireMock",                "mock",      r"^wiremock-service"),
    ("couchbase",    "Couchbase",               "couchbase", r"couchbase"),
    ("elastic",      "Elasticsearch",           "elastic",   r"(elasticsearch|es-master)"),
    ("kafkaui",      "Kafka UI",                "kafka",     r"^kafka-ui"),
]


def _discover_ocp_services(cluster_id):
    """Build a service catalog for an OCP cluster by scanning OpenShift Routes
    across every namespace and pattern-matching against _OCP_SERVICE_CATALOG.

    Returns a list of {key, label, icon, namespace, host, url} entries.
    Uses a single cluster-wide list call (cheap, one round-trip).
    """
    try:
        co = _custom_objects(cluster_id)
    except Exception:
        return []
    try:
        routes = co.list_cluster_custom_object(
            group="route.openshift.io", version="v1", plural="routes",
            _request_timeout=15,
        )
    except Exception:
        return []

    catalog = [(key, label, icon, re.compile(pat, re.IGNORECASE))
               for (key, label, icon, pat) in _OCP_SERVICE_CATALOG]
    seen = set()
    services = []
    for route in (routes.get("items", []) or []):
        spec = route.get("spec", {}) or {}
        host = spec.get("host", "") or ""
        if not host:
            continue
        ns = (route.get("metadata", {}) or {}).get("namespace", "")
        scheme = "https" if spec.get("tls") else "http"
        for key, label, icon, rx in catalog:
            if rx.search(host):
                if (key, host) in seen:
                    break
                seen.add((key, host))
                services.append({
                    "key": key, "label": label, "icon": icon,
                    "namespace": ns, "host": host,
                    "url": f"{scheme}://{host}",
                })
                break
    role_order = {"runtime": 0, "authoring": 1, "backingservices": 2}

    def _sort_key(s):
        ns = s["namespace"] or ""
        # Group by NS role (rt/au/bs) first, platform stuff last.
        role = _ns_role(ns)
        role_idx = {"rt": 0, "au": 1, "bs": 2}.get(role, 9)
        # Platform services (Console, Vault, ArgoCD) get sorted to top
        if s["key"] in ("console", "vault", "argocd"):
            return (-1, s["label"].lower())
        return (role_idx, s["label"].lower())

    services.sort(key=_sort_key)
    return services


def _discover_aws_services(cluster_id):
    """Build a service catalog for an AWS EKS cluster by scanning ingresses.

    Returns a list of {key, label, icon, namespace, host, url} entries.
    Matching is per-host (one ingress can bundle multiple service hosts).
    """
    try:
        net = _networking_v1(cluster_id)
    except Exception:
        return []

    catalog = [(key, label, icon, re.compile(pat, re.IGNORECASE))
               for (key, label, icon, pat) in _AWS_SERVICE_CATALOG]

    seen = set()
    services = []
    for ns in _AWS_SERVICE_NS_CANDIDATES:
        try:
            ings = net.list_namespaced_ingress(ns, _request_timeout=5)
        except Exception:
            continue
        for ing in (ings.items or []):
            spec = ing.spec
            if not spec:
                continue
            tls_hosts = set()
            for t in (spec.tls or []):
                for h in (t.hosts or []):
                    tls_hosts.add(h)
            for rule in (spec.rules or []):
                host = getattr(rule, "host", "") or ""
                if not host:
                    continue
                for key, label, icon, rx in catalog:
                    if rx.search(host):
                        if (key, host) in seen:
                            break
                        seen.add((key, host))
                        scheme = "https" if host in tls_hosts else "http"
                        services.append({
                            "key": key,
                            "label": label,
                            "icon": icon,
                            "namespace": ns,
                            "host": host,
                            "url": f"{scheme}://{host}",
                        })
                        break
    role_order = {"runtime": 0, "authoring": 1, "backingservices": 2, "catalog": 3,
                  "argocd": 4, "headlamp": 5}
    services.sort(key=lambda s: (role_order.get(s["namespace"], 99), s["label"].lower()))
    return services


def _discover_headlamp_url(cluster_id):
    """Discover the Headlamp UI URL on an EKS cluster.

    Headlamp is the web UI for Kubernetes clusters that don't have a built-in
    console (like EKS). It's exposed via an Ingress in the `headlamp`
    namespace (or similar).
    """
    try:
        net = _networking_v1(cluster_id)
    except Exception:
        return ""
    for ns in ("headlamp", "kube-headlamp"):
        try:
            ings = net.list_namespaced_ingress(ns, _request_timeout=5)
            for ing in ings.items:
                rules = (ing.spec.rules or []) if ing.spec else []
                for rule in rules:
                    host = getattr(rule, "host", "") or ""
                    if not host:
                        continue
                    tls_hosts = set()
                    if ing.spec and ing.spec.tls:
                        for t in ing.spec.tls:
                            for h in (t.hosts or []):
                                tls_hosts.add(h)
                    scheme = "https" if host in tls_hosts else "http"
                    return f"{scheme}://{host}"
        except Exception:
            continue
    return ""


def _discover_argocd_url(cluster_id):
    """Discover ArgoCD server URL.

    OCP: looks for an OpenShift Route in candidate namespaces.
    EKS: falls back to Ingress in the `argocd` namespace.
    """
    # Try OpenShift Routes first (OCP)
    try:
        co = _custom_objects(cluster_id)
        for ns in _ARGOCD_NS_CANDIDATES:
            try:
                routes = co.list_namespaced_custom_object(
                    group="route.openshift.io", version="v1",
                    namespace=ns, plural="routes",
                    _request_timeout=5,
                )
                for route in routes.get("items", []):
                    name = route.get("metadata", {}).get("name", "")
                    spec = route.get("spec", {})
                    host = spec.get("host", "")
                    if not host:
                        continue
                    if "argocd" in name.lower() and "server" in name.lower():
                        scheme = "https" if spec.get("tls") else "http"
                        return f"{scheme}://{host}"
                for route in routes.get("items", []):
                    spec = route.get("spec", {})
                    host = spec.get("host", "")
                    if host and "argocd" in host.lower():
                        scheme = "https" if spec.get("tls") else "http"
                        return f"{scheme}://{host}"
            except Exception:
                continue
    except Exception:
        pass

    # Fall back to Ingress (EKS / non-OCP)
    try:
        net = _networking_v1(cluster_id)
        for ns in _ARGOCD_NS_CANDIDATES:
            try:
                ings = net.list_namespaced_ingress(ns, _request_timeout=5)
                for ing in ings.items:
                    name = (ing.metadata.name or "").lower()
                    rules = (ing.spec.rules or []) if ing.spec else []
                    for rule in rules:
                        host = getattr(rule, "host", "") or ""
                        if not host:
                            continue
                        if "argocd" in name or "argocd" in host.lower():
                            tls_hosts = set()
                            if ing.spec and ing.spec.tls:
                                for t in ing.spec.tls:
                                    for h in (t.hosts or []):
                                        tls_hosts.add(h)
                            scheme = "https" if host in tls_hosts else "http"
                            return f"{scheme}://{host}"
            except Exception:
                continue
    except Exception:
        pass
    return ""


def _decode_helm_chart_version(secret_data):
    """Extract chart name+version from a Helm v3 release secret's 'release' field."""
    try:
        raw = secret_data.get("release", "")
        if not raw:
            return "", ""
        decoded = gzip.decompress(base64.b64decode(base64.b64decode(raw)))
        rel = json.loads(decoded)
        chart_meta = rel.get("chart", {}).get("metadata", {})
        return chart_meta.get("name", ""), chart_meta.get("version", "")
    except Exception:
        return "", ""


def _get_helm_releases(cluster_id, namespace):
    """List Helm releases in a namespace by reading Helm v3 release secrets.

    Phase 1: lightweight list with labels only (no data) to find latest revision.
    Phase 2: fetch each latest-revision secret individually to decode chart version.
    """
    releases = []
    if not namespace:
        return releases
    try:
        v1 = _core_v1(cluster_id)
        # Phase 1 — labels only (fast, no payload)
        secret_list = v1.list_namespaced_secret(
            namespace, label_selector="owner=helm",
            _preload_content=False, _request_timeout=10,
        )
        items = json.loads(secret_list.read()).get("items", [])

        latest = {}
        for s in items:
            labels = (s.get("metadata") or {}).get("labels") or {}
            name = labels.get("name", "")
            if not name:
                continue
            version = int(labels.get("version", "0") or "0")
            secret_name = (s.get("metadata") or {}).get("name", "")
            if name in latest and latest[name]["version"] >= version:
                continue
            latest[name] = {
                "version": version,
                "status": labels.get("status", "unknown"),
                "updated": (s.get("metadata") or {}).get("creationTimestamp", ""),
                "secret_name": secret_name,
            }

        # Phase 2 — fetch only latest-revision secrets to decode chart version
        def _fetch_one(release_name, info):
            try:
                sec = v1.read_namespaced_secret(info["secret_name"], namespace, _request_timeout=5)
                chart_name, chart_ver = _decode_helm_chart_version(sec.data or {})
                return release_name, chart_name, chart_ver
            except Exception:
                return release_name, "", ""

        chart_versions = {}
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(_fetch_one, n, info): n for n, info in latest.items()}
            for f in as_completed(futures, timeout=15):
                try:
                    rname, cname, cver = f.result()
                    chart_versions[rname] = (cname, cver)
                except Exception:
                    pass

        for name, info in latest.items():
            cname, cver = chart_versions.get(name, ("", ""))
            releases.append({
                "name": name,
                "namespace": namespace,
                "revision": info["version"],
                "status": info["status"],
                "chart": cname or name,
                "chart_version": cver,
                "updated": info["updated"],
            })
        releases.sort(key=lambda r: r["name"])
    except Exception as exc:
        log.warning("Failed to list Helm releases in %s/%s: %s", cluster_id, namespace, exc)
    return releases


def _pretty_short_name(cfg, cid):
    """Friendly display name for a cluster, e.g. 'prodocpcluster401' -> 'ocp-401'
    and 'vpc002-aws1-dev-eks' -> 'aws1'. The real full_name / cluster_id are
    kept untouched for identity; this is purely for the UI.

    An explicit 'short_name' (or 'display_name') in the cluster config always
    wins, so operators can override the derived value.
    """
    explicit = cfg.get("short_name") or cfg.get("display_name")
    if explicit:
        return explicit
    name = cfg.get("full_name") or cfg.get("eks_cluster_name") or cid or ""
    m = re.search(r"aws[-_]?(\d+)", name, re.IGNORECASE)
    if m:
        return f"aws{m.group(1)}"
    m = re.search(r"rgs[-_]?(\d+)", name, re.IGNORECASE)
    if m:
        return f"ocp-{m.group(1)}"
    return cid or name


def _fetch_cluster_overview(cid, cfg):
    """Fetch overview data for a single cluster. Called in parallel."""
    cloud = (cfg.get("provider") or "ocp").lower()
    entry = {
        "cluster_id": cid,
        "full_name": cfg.get("full_name", cid),
        "short_name": _pretty_short_name(cfg, cid),
        "console_url": cfg.get("console_url", ""),
        "headlamp_url": cfg.get("headlamp_url", ""),
        "api_url": cfg.get("api_url", ""),
        "vault_url": cfg.get("vault_url", ""),
        "argocd_url": cfg.get("argocd_url", ""),
        "crd_namespace": cfg.get("crd_namespace", "ms360-platform-crd"),
        "ocp_version": "",
        "region": cfg.get("region", ""),
        "cloud": cloud,            # "ocp" or "aws" - used for UI filtering
        "provider": "",            # underlying infra detected (e.g. "VMware vSphere", "Amazon EC2")
        "status": "Unknown",
        "status_details": [],
        "total_nodes": 0,
        "node_roles": {},
        "nodes": [],                # AWS only: per-node detail
        "services": [],             # service catalog (Ingresses on EKS, Routes on OCP)
        "hf_summary": {},           # cluster-level HF/product-versions per role-ns
        "total_envs": 0,
        "total_drops": 0,
        "drops": [],
        "environments": [],
        "crd_releases": [],
        "crd_total": 0,
    }
    try:
        _get_api_client(cid)

        crd_ns = cfg.get("crd_namespace", "ms360-platform-crd")
        pool = ThreadPoolExecutor(max_workers=10)
        f_version = pool.submit(_get_eks_version, cid, cfg) if cloud == "aws" \
            else pool.submit(_get_ocp_version, cid)
        f_platform = pool.submit(_get_infra_platform, cid)
        f_health = pool.submit(_get_cluster_health, cid)
        f_envs = pool.submit(_discover_environments_on_cluster, cid)
        f_crd = pool.submit(_get_helm_releases, cid, crd_ns)
        f_vault = pool.submit(_discover_vault_url, cid, cfg.get("vault_url", ""))
        f_argocd = pool.submit(_discover_argocd_url, cid)
        # Service catalog discovery — unified across OCP (Routes) + EKS (Ingresses)
        is_aws = (cloud == "aws")
        f_headlamp = pool.submit(_discover_headlamp_url, cid) if is_aws else None
        f_services = pool.submit(
            _discover_aws_services if is_aws else _discover_ocp_services, cid
        )
        # Cluster-level HF/product-version summary (one CM list call across all NS)
        f_hf = pool.submit(_list_all_product_version_cms, cid)

        entry["ocp_version"] = f_version.result()
        detected_platform = f_platform.result()
        if detected_platform:
            entry["provider"] = detected_platform

        entry["status"], entry["status_details"], node_items = f_health.result()

        entry["total_nodes"] = len(node_items)
        cluster_prefix = cfg.get("eks_cluster_name") or cfg.get("full_name") or cid
        role_counts = {}
        for node in node_items:
            labels = node.metadata.labels or {}
            role = _node_role(labels, cloud, cluster_prefix)
            role_counts[role] = role_counts.get(role, 0) + 1
        entry["node_roles"] = role_counts

        # Per-node detail (uniformly enabled for OCP + EKS — same fleet card layout)
        try:
            entry["nodes"] = _build_node_details(cid, node_items)
        except Exception as nd_err:
            log.warning("Node detail build failed for %s: %s", cid, nd_err)

        envs = f_envs.result()
        drop_set = set()
        for env in envs:
            dv = env.get("drop_version_raw", "")
            if dv:
                drop_set.add(dv)
        entry["total_envs"] = len(envs)
        entry["total_drops"] = len(drop_set) or 1
        entry["drops"] = sorted([_fmt_drop(d) for d in drop_set], reverse=True) if drop_set else ["N/A"]
        entry["environments"] = [e["name"] for e in envs]

        try:
            crd_releases = f_crd.result(timeout=20)
            entry["crd_releases"] = crd_releases
            entry["crd_total"] = len(crd_releases)
        except Exception as crd_err:
            log.warning("CRD fetch failed for %s: %s", cid, crd_err)
        try:
            entry["vault_url"] = f_vault.result(timeout=10) or entry["vault_url"]
        except Exception as vault_err:
            log.warning("Vault URL discovery failed for %s: %s", cid, vault_err)
        try:
            entry["argocd_url"] = f_argocd.result(timeout=8) or entry["argocd_url"]
        except Exception as argo_err:
            log.warning("ArgoCD URL discovery failed for %s: %s", cid, argo_err)
        # EKS only: Headlamp = the cluster UI (acts as the "console")
        if f_headlamp is not None:
            try:
                hl = f_headlamp.result(timeout=8)
                if hl:
                    # Headlamp is the EKS cluster's web UI - use it as the console
                    entry["console_url"] = hl
                    entry["headlamp_url"] = hl
            except Exception as hl_err:
                log.warning("Headlamp URL discovery failed for %s: %s", cid, hl_err)
        # Service catalog (Couchbase, Kafka UI, ApiGW, ...) — same for OCP + EKS
        try:
            entry["services"] = f_services.result(timeout=15) or []
        except Exception as svc_err:
            log.warning("Service catalog discovery failed for %s: %s", cid, svc_err)
        # Cluster-level HF summary (per role-ns)
        try:
            all_cms = f_hf.result(timeout=15) or {}
            entry["hf_summary"] = _summarize_cluster_hfs(cid, all_cms)
        except Exception as hf_err:
            log.warning("HF summary failed for %s: %s", cid, hf_err)
        pool.shutdown(wait=False)
    except Exception as e:
        try:
            pool.shutdown(wait=False)
        except Exception:
            pass
        log.warning("Failed to reach cluster %s: %s", cid, e, exc_info=True)
        entry["status"] = f"Unreachable: {e}"
    return entry


_clusters_cache = {"ts": 0, "data": None}
_clusters_cache_lock = threading.Lock()
_CLUSTERS_CACHE_TTL = 30  # seconds


def get_clusters_overview():
    import time as _time
    now = _time.time()
    with _clusters_cache_lock:
        if _clusters_cache["data"] is not None and (now - _clusters_cache["ts"]) < _CLUSTERS_CACHE_TTL:
            return _clusters_cache["data"]

    if len(CLUSTERS_CONFIG) == 1:
        cid, cfg = next(iter(CLUSTERS_CONFIG.items()))
        result = [_fetch_cluster_overview(cid, cfg)]
    else:
        with ThreadPoolExecutor(max_workers=len(CLUSTERS_CONFIG)) as pool:
            futures = {
                pool.submit(_fetch_cluster_overview, cid, cfg): cid
                for cid, cfg in CLUSTERS_CONFIG.items()
            }
            result = [fut.result() for fut in as_completed(futures)]

    with _clusters_cache_lock:
        _clusters_cache["ts"] = _time.time()
        _clusters_cache["data"] = result
    return result


# ---------------------------------------------------------------------------
# Environment discovery
# ---------------------------------------------------------------------------

def _discover_aws_envs(cluster_id, cfg, namespaces):
    """Discover environments on an AWS EKS cluster (flat namespace layout).

    One EKS cluster = one environment. Namespaces are bare role names:
    `runtime`, `authoring`, `backingservices`. The environment name comes
    from the cluster config (env_name -> eks_cluster_name -> full_name -> cluster_id).
    """
    present_roles = {ns.metadata.name for ns in namespaces.items} & set(NAMESPACE_SUFFIXES)
    if not present_roles:
        return []

    env_name = cfg.get("env_name") or cfg.get("eks_cluster_name") or cfg.get("full_name") or cluster_id
    entry = {
        "name": env_name,
        "datacenter": cluster_id,
        "env_id": env_name,
        "namespaces": {role: role for role in present_roles},
        "drop_version": "",
        "drop_version_raw": "",
        "env_owner": "",
        "bitbucket_branch": "",
        "is_master": False,
    }

    if "runtime" in entry["namespaces"]:
        try:
            meta = _get_env_metadata(cluster_id, "runtime")
            if meta:
                entry["bitbucket_branch"] = meta.get("bitbucket_branch", "")
                entry["env_owner"] = meta.get("env_owner", "")
                entry["is_master"] = meta.get("is_master", False)
                raw = meta.get("drop_version_raw")
                if raw:
                    entry["drop_version_raw"] = raw
                    entry["drop_version"] = _fmt_drop(raw)
        except Exception as e:
            log.warning("Failed to read env metadata on AWS cluster %s: %s", cluster_id, e)

    return [entry]


def _discover_environments_on_cluster(cluster_id):
    """Discover all environments on a cluster.

    Layout depends on the cloud provider:
      - OCP (default):  namespaces follow rgs-<cluster>-<env>-<role>
                        e.g. rgs-il07-env8-runtime
      - AWS EKS:        flat namespaces: just runtime / authoring / backingservices
                        (one environment per cluster)
    """
    cfg = CLUSTERS_CONFIG.get(cluster_id, {})
    cloud = (cfg.get("provider") or "ocp").lower()
    v1 = _core_v1(cluster_id)
    namespaces = v1.list_namespace()

    if cloud == "aws":
        return _discover_aws_envs(cluster_id, cfg, namespaces)

    pattern = re.compile(
        rf"^({re.escape(NAMESPACE_PREFIX)}-\w[\w-]*?)-({'|'.join(NAMESPACE_SUFFIXES)})$"
    )
    env_map = {}
    for ns in namespaces.items:
        name = ns.metadata.name
        match = pattern.match(name)
        if match:
            env_name = match.group(1)
            suffix = match.group(2)
            if env_name not in env_map:
                parts = env_name.split("-")
                env_map[env_name] = {
                    "name": env_name,
                    "datacenter": cluster_id,
                    "env_id": "-".join(parts[2:]) if len(parts) > 2 else "",
                    "namespaces": {},
                    "drop_version": "",
                    "drop_version_raw": "",
                    "env_owner": "",
                    "bitbucket_branch": "",
                    "is_master": False,
                }
            env_map[env_name]["namespaces"][suffix] = name

            annotations = ns.metadata.annotations or {}
            desc = annotations.get("openshift.io/description", "")
            display = annotations.get("openshift.io/display-name", "")
            if not env_map[env_name]["drop_version_raw"]:
                for ann_val in [desc, display]:
                    if ann_val and "_" in ann_val:
                        raw = ann_val.strip().split("_")[-1]
                        if raw.isdigit() and len(raw) == 4:
                            env_map[env_name]["drop_version_raw"] = raw
                            env_map[env_name]["drop_version"] = _fmt_drop(raw)
                            log.info("Drop %s for %s from annotation: %s", raw, env_name, ann_val)
                            break
                else:
                    log.info("No drop in annotations for %s (desc=%r, display=%r)", name, desc, display)

    # Fetch metadata for all envs in parallel
    meta_tasks = {
        env_name: env["namespaces"].get("runtime", "")
        for env_name, env in env_map.items()
        if env["namespaces"].get("runtime", "")
    }
    meta_results = {}
    if meta_tasks:
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {
                pool.submit(_get_env_metadata, cluster_id, ns): name
                for name, ns in meta_tasks.items()
            }
            for fut in as_completed(futures):
                name = futures[fut]
                try:
                    meta_results[name] = fut.result()
                except Exception:
                    meta_results[name] = {}

    for env_name, env in env_map.items():
        meta = meta_results.get(env_name, {})
        if meta:
            env["bitbucket_branch"] = meta.get("bitbucket_branch", "")
            env["env_owner"] = meta.get("env_owner", "")
            env["is_master"] = meta.get("is_master", False)
            if meta.get("drop_version_raw") and not env["drop_version_raw"]:
                env["drop_version_raw"] = meta["drop_version_raw"]
                env["drop_version"] = _fmt_drop(meta["drop_version_raw"])

        name_lower = env_name.lower()
        if "mst" in name_lower or "master" in name_lower:
            env["is_master"] = True

        if not env["drop_version_raw"]:
            inferred = _extract_drop_from_env_id(env.get("env_id", ""))
            if inferred:
                env["drop_version_raw"] = inferred
                env["drop_version"] = _fmt_drop(inferred)

    return list(env_map.values())


def discover_environments(cluster_id=None):
    if cluster_id:
        return _discover_environments_on_cluster(cluster_id)
    cluster_ids = list(CLUSTERS_CONFIG.keys())
    if len(cluster_ids) <= 1:
        return _discover_environments_on_cluster(cluster_ids[0]) if cluster_ids else []
    envs = []
    with ThreadPoolExecutor(max_workers=len(cluster_ids)) as pool:
        futures = {pool.submit(_discover_environments_on_cluster, cid): cid for cid in cluster_ids}
        for f in as_completed(futures):
            try:
                envs.extend(f.result())
            except Exception as e:
                log.warning("Failed to discover envs on %s: %s", futures[f], e)
    return envs


# ---------------------------------------------------------------------------
# Drops overview
# ---------------------------------------------------------------------------

def get_drops_overview(cluster_id=None):
    cluster_ids = [cluster_id] if cluster_id else list(CLUSTERS_CONFIG.keys())
    drops = {}
    for cid in cluster_ids:
        envs = _discover_environments_on_cluster(cid)

        # Fetch sanity data for all envs in parallel
        sanity_map = {}
        sanity_tasks = []
        for env in envs:
            runtime_ns = env["namespaces"].get("runtime", "")
            if runtime_ns:
                sanity_tasks.append((env["name"], cid, runtime_ns))

        if sanity_tasks:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {
                    pool.submit(_get_sanity_data, c, ns): name
                    for name, c, ns in sanity_tasks
                }
                for fut in as_completed(futures):
                    name = futures[fut]
                    try:
                        sanity_map[name] = fut.result()
                    except Exception:
                        sanity_map[name] = {
                            "sanity_passrate": "N/A", "sanity_passrate_value": 0,
                            "sanity_jar_version": "",
                        }

        for env in envs:
            dv = env.get("drop_version", "") or _fmt_drop(env.get("drop_version_raw", ""))
            raw = env.get("drop_version_raw", "")
            if not dv:
                dv = "N/A"
            if dv not in drops:
                drops[dv] = {
                    "drop_version": dv,
                    "drop_version_raw": raw,
                    "environments": [],
                }

            sanity = sanity_map.get(env["name"], {
                "sanity_passrate": "N/A", "sanity_passrate_value": 0,
                "sanity_jar_version": "",
            })

            drops[dv]["environments"].append({
                "name": env["name"],
                "datacenter": env.get("datacenter", cid),
                "env_id": env.get("env_id", ""),
                "env_owner": env.get("env_owner", ""),
                "bitbucket_branch": env.get("bitbucket_branch", ""),
                "is_master": env.get("is_master", False),
                "sanity_passrate": sanity.get("sanity_passrate", "N/A"),
                "sanity_passrate_value": sanity.get("sanity_passrate_value", 0),
                "sanity_jar_version": sanity.get("sanity_jar_version", ""),
            })

    return sorted(drops.values(), key=lambda d: d.get("drop_version_raw", ""), reverse=True)


# ---------------------------------------------------------------------------
# Environment metadata
# ---------------------------------------------------------------------------

def _get_env_metadata(cluster_id, namespace):
    default = {
        "drop_version": "", "drop_version_raw": "",
        "bitbucket_branch": "", "bitbucket_repo_url": "",
        "env_owner": "", "is_master": False,
        "jenkins_deploy_pipeline": "", "jenkins_automation_pipeline": "",
        "team": "", "stream": "", "project": "",
        "creation_date": "", "last_update": "", "idle_days": 0,
    }
    v1 = _core_v1(cluster_id)
    try:
        cm = v1.read_namespaced_config_map(ENV_META_CONFIGMAP_NAME, namespace)
        data = cm.data or {}
        default.update({
            "bitbucket_branch": data.get("bitbucket_branch", ""),
            "bitbucket_repo_url": data.get("bitbucket_repo_url", ""),
            "env_owner": data.get("env_owner", ""),
            "is_master": data.get("is_master", "false").lower() == "true",
            "jenkins_deploy_pipeline": data.get("jenkins_deploy_pipeline", ""),
            "jenkins_automation_pipeline": data.get("jenkins_automation_pipeline", ""),
            "team": data.get("team", ""),
            "stream": data.get("stream", ""),
            "project": data.get("project", ""),
            "creation_date": data.get("creation_date", ""),
            "last_update": data.get("last_update", ""),
        })
        if data.get("idle_days"):
            try:
                default["idle_days"] = int(data["idle_days"])
            except (ValueError, TypeError):
                pass
        if data.get("drop_version"):
            raw = data["drop_version"]
            default["drop_version_raw"] = raw
            default["drop_version"] = _fmt_drop(raw)
    except Exception:
        pass

    if not default["drop_version_raw"]:
        try:
            ns_obj = v1.read_namespace(namespace)
            ann = ns_obj.metadata.annotations or {}
            desc = (ann.get("openshift.io/description", "")
                    or ann.get("openshift.io/display-name", ""))
            if "_" in desc:
                raw = desc.strip().split("_")[-1]
                if raw.isdigit() and len(raw) == 4:
                    default["drop_version_raw"] = raw
                    default["drop_version"] = _fmt_drop(raw)
        except Exception:
            pass

    if not default["drop_version_raw"]:
        parts = namespace.split("-")
        if len(parts) >= 4:
            env_id = "-".join(parts[2:-1])
            inferred = _extract_drop_from_env_id(env_id)
            if inferred:
                default["drop_version_raw"] = inferred
                default["drop_version"] = _fmt_drop(inferred)

    return default


# ---------------------------------------------------------------------------
# Sanity data
# ---------------------------------------------------------------------------

def _get_sanity_data(cluster_id, runtime_ns):
    v1 = _core_v1(cluster_id)
    try:
        cm = v1.read_namespaced_config_map(SANITY_CONFIGMAP_NAME, runtime_ns)
        data = cm.data or {}
        passrate_str = data.get("sanity_passrate", "0%").replace("%", "")
        passrate = float(passrate_str) if passrate_str else 0
        total = int(data.get("total_tests", 0) or 0)
        passed = int(data.get("passed_tests", 0) or 0)
        failed = data.get("failed_tests", str(max(0, total - passed)))
        return {
            "sanity_passrate": f"{passrate}%",
            "sanity_passrate_value": passrate,
            "jenkins_build_url": data.get("jenkins_build_url", ""),
            "jenkins_build_number": data.get("jenkins_build_number", ""),
            "last_run": data.get("last_run", ""),
            "total_tests": str(total),
            "passed_tests": str(passed),
            "failed_tests": str(failed),
            "suite": data.get("suite", ""),
            "sanity_jar_version": data.get("sanity_jar_version", ""),
            "triggered_by": data.get("triggered_by", ""),
        }
    except Exception:
        return {
            "sanity_passrate": "N/A", "sanity_passrate_value": 0,
            "jenkins_build_url": "", "jenkins_build_number": "",
            "last_run": "", "total_tests": "0", "passed_tests": "0",
            "failed_tests": "0", "suite": "", "sanity_jar_version": "",
            "triggered_by": "",
        }


def _get_sanity_with_history(cluster_id, runtime_ns):
    """Fetch sanity data + history in a single ConfigMap read."""
    try:
        v1 = _core_v1(cluster_id)
        cm = v1.read_namespaced_config_map(SANITY_CONFIGMAP_NAME, runtime_ns)
        data = cm.data or {}
        passrate_str = data.get("sanity_passrate", "0%").replace("%", "")
        passrate = float(passrate_str) if passrate_str else 0
        total = int(data.get("total_tests", 0) or 0)
        passed = int(data.get("passed_tests", 0) or 0)
        failed = data.get("failed_tests", str(max(0, total - passed)))
        hist_raw = data.get("history", "[]")
        history = json.loads(hist_raw) if hist_raw else []
        return {
            "sanity_passrate": f"{passrate}%",
            "sanity_passrate_value": passrate,
            "jenkins_build_url": data.get("jenkins_build_url", ""),
            "jenkins_build_number": data.get("jenkins_build_number", ""),
            "last_run": data.get("last_run", ""),
            "total_tests": str(total),
            "passed_tests": str(passed),
            "failed_tests": str(failed),
            "suite": data.get("suite", ""),
            "sanity_jar_version": data.get("sanity_jar_version", ""),
            "triggered_by": data.get("triggered_by", ""),
            "history": history,
        }
    except Exception:
        return {
            "sanity_passrate": "N/A", "sanity_passrate_value": 0,
            "jenkins_build_url": "", "jenkins_build_number": "",
            "last_run": "", "total_tests": "0", "passed_tests": "0",
            "failed_tests": "0", "suite": "", "sanity_jar_version": "",
            "triggered_by": "", "history": [],
        }


# ---------------------------------------------------------------------------
# Deployment info
# ---------------------------------------------------------------------------

def _get_deployment_info(cluster_id, namespace):
    default = {
        "jenkins_deploy_url": "", "jenkins_deploy_build_number": "",
        "jenkins_deploy_status": "N/A", "jenkins_deploy_timestamp": "",
        "triggered_by": "",
    }
    try:
        v1 = _core_v1(cluster_id)
        cm = v1.read_namespaced_config_map(DEPLOYMENT_CONFIGMAP_NAME, namespace)
        data = cm.data or {}
        return {
            "jenkins_deploy_url": data.get("jenkins_deploy_url", ""),
            "jenkins_deploy_build_number": data.get("jenkins_deploy_build_number", ""),
            "jenkins_deploy_status": data.get("jenkins_deploy_status", "N/A"),
            "jenkins_deploy_timestamp": data.get("jenkins_deploy_timestamp", ""),
            "triggered_by": data.get("triggered_by", ""),
        }
    except Exception:
        return default


# ---------------------------------------------------------------------------
# Catalog data files
# ---------------------------------------------------------------------------

def _get_catalog_data_files(cluster_id, runtime_ns):
    try:
        v1 = _core_v1(cluster_id)
        cm = v1.read_namespaced_config_map(CATALOG_DATA_CONFIGMAP_NAME, runtime_ns)
        data = cm.data or {}
        return {
            "custom_data_zip": data.get("custom_data_zip", ""),
            "custom_bp_zip": data.get("custom_bp_zip", ""),
            "deployed_by": data.get("deployed_by", ""),
            "deploy_timestamp": data.get("deploy_timestamp", ""),
            "jenkins_data_deploy_url": data.get("jenkins_data_deploy_url", ""),
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Product HF versions
# ---------------------------------------------------------------------------

_PRODUCT_VERSION_KEYS = [
    "baseline", "platform", "catalog", "csr", "oc", "oh",
    "care", "mass", "d1_suite", "backoffice", "mpp",
]

# Hotfix-number keys (last segment of releaseVersion in each product's
# Nexus release-descriptor YAML). d1_suite and mpp deliberately omitted.
_PRODUCT_HF_KEYS = [
    "baseline_hf", "platform_hf", "catalog_hf", "csr_hf",
    "oc_hf", "oh_hf", "care_hf", "mass_hf", "backoffice_hf",
]

# Products that are ONLY valid in specific namespace roles.
# If a product key appears here, values from other namespace roles are
# ignored (treats stale data as empty). Products NOT listed here are
# allowed in all namespaces.
_PRODUCT_NS_SCOPE = {
    "platform":   {"bs"},
    "oc":         {"rt"},
    "oh":         {"rt"},
    "care":       {"rt"},
    "mass":       {"rt"},
    "backoffice": {"rt"},
}

def _product_allowed_in_ns(product_key, ns_role):
    """Return True if the product is valid for this namespace role (rt/au/bs)."""
    scope = _PRODUCT_NS_SCOPE.get(product_key)
    if scope is None:
        return True
    return ns_role in scope

def _get_product_versions(cluster_id, runtime_ns):
    try:
        v1 = _core_v1(cluster_id)
        cm = v1.read_namespaced_config_map(PRODUCT_VERSIONS_CONFIGMAP_NAME, runtime_ns)
        data = cm.data or {}
        result = {k: data.get(k, "") for k in _PRODUCT_VERSION_KEYS}
        for k in _PRODUCT_HF_KEYS:
            result[k] = data.get(k, "")
        result["last_update"] = data.get("last_update", "")
        return result
    except Exception:
        empty = {k: "" for k in _PRODUCT_VERSION_KEYS}
        for k in _PRODUCT_HF_KEYS:
            empty[k] = ""
        empty["last_update"] = ""
        return empty


def _summarize_cluster_hfs(cluster_id, all_cms):
    """Build a per-role HF/product-version summary at the cluster level.

    Picks the most-recently-updated `product-versions` ConfigMap for each
    role (rt/au/bs) — i.e. the master env's data when present, otherwise
    the freshest write the pipeline made. Same fields as the env detail
    view, just collapsed to one entry per role.

    Returns: {"rt": {...}, "au": {...}, "bs": {...}, "any": bool}
    """
    by_role = {"rt": None, "au": None, "bs": None}
    by_role_ts = {"rt": "", "au": "", "bs": ""}
    for ns, data in (all_cms or {}).items():
        role = _ns_role(ns)
        if role == "other":
            continue
        ts = (data.get("last_update") or "") if data else ""
        if data and (ts > by_role_ts[role] or by_role[role] is None):
            by_role[role] = {"namespace": ns, **_build_product_versions_view(data)}
            by_role_ts[role] = ts
    return {
        "rt": by_role["rt"] or {},
        "au": by_role["au"] or {},
        "bs": by_role["bs"] or {},
        "any": any(v for v in by_role.values()),
    }


def _list_all_product_version_cms(cluster_id):
    """
    Bulk-fetch every product-versions ConfigMap on the cluster in ONE
    label-selector list call.

    Returns: {namespace: {data...}} — keyed by namespace name.

    Why this exists: the env-table view shows N envs × 3 namespaces of
    product-version data. Reading each CM individually meant 3*N
    sequential GETs (per env), which dominated the env-table latency once
    we expanded to per-NS merging. A single labeled list call is roughly
    O(1) network roundtrips regardless of env count.
    """
    try:
        v1 = _core_v1(cluster_id)
        # Filter by the broad app label only; the precise CM name filter
        # below catches both new (with type=versions) and older CMs that
        # may have been created before we started labeling by type.
        cms = v1.list_config_map_for_all_namespaces(
            label_selector="app=rogers-dashboard",
            timeout_seconds=15,
        )
        return {
            cm.metadata.namespace: (cm.data or {})
            for cm in (cms.items or [])
            if cm.metadata.name == PRODUCT_VERSIONS_CONFIGMAP_NAME
        }
    except Exception as exc:
        print(f"[k8s_client] bulk product-versions list failed for {cluster_id}: {exc}", flush=True)
        return {}


def _build_product_versions_view(data):
    """Project a raw CM data dict into the same shape as _get_product_versions."""
    if not data:
        empty = {k: "" for k in _PRODUCT_VERSION_KEYS}
        for k in _PRODUCT_HF_KEYS:
            empty[k] = ""
        empty["last_update"] = ""
        return empty
    result = {k: data.get(k, "") for k in _PRODUCT_VERSION_KEYS}
    for k in _PRODUCT_HF_KEYS:
        result[k] = data.get(k, "")
    result["last_update"] = data.get("last_update", "")
    return result


def _merge_product_versions_from_views(namespaces, ns_views):
    """
    Build the merged + by_ns + divergent view from a dict of pre-fetched
    {namespace: ns_view} mappings. No network I/O. Used by both the
    cached path (env-table bulk fetch) and the per-call path (env-detail
    parallel fetch). Mirrors _get_product_versions_merged's output shape.
    """
    merged = {k: "" for k in _PRODUCT_VERSION_KEYS}
    for k in _PRODUCT_HF_KEYS:
        merged[k] = ""
    merged["last_update"] = ""

    src_ts = {k: "" for k in merged.keys()}
    by_ns = {}
    distinct_values = {k: set() for k in _PRODUCT_VERSION_KEYS}

    for ns in namespaces:
        if not ns:
            continue
        ns_data = ns_views.get(ns) or _build_product_versions_view(None)
        ns_ts = ns_data.get("last_update", "") or ""
        role = _ns_role(ns)
        ns_view = {"namespace": ns, "last_update": ns_ts}
        for k in _PRODUCT_VERSION_KEYS:
            v = ns_data.get(k, "") or ""
            if v and not _product_allowed_in_ns(k, role):
                v = ""
            ns_view[k] = v
            if v:
                distinct_values[k].add(v)
        for k in _PRODUCT_HF_KEYS:
            v = ns_data.get(k, "") or ""
            base_key = k.replace("_hf", "")
            if v and not _product_allowed_in_ns(base_key, role):
                v = ""
            ns_view[k] = v
        by_ns[role] = ns_view

        for k in list(merged.keys()):
            if k == "last_update":
                continue
            v = ns_data.get(k, "") or ""
            if not v:
                continue
            base_key = k.replace("_hf", "")
            if not _product_allowed_in_ns(base_key, role):
                continue
            cur = merged[k]
            if not cur or ns_ts > src_ts[k]:
                merged[k] = v
                src_ts[k] = ns_ts
        if ns_ts > merged["last_update"]:
            merged["last_update"] = ns_ts

    merged["by_ns"] = by_ns
    merged["divergent"] = sorted([k for k, vals in distinct_values.items() if len(vals) > 1])
    return merged


def _ns_role(ns_name):
    """Map a namespace name to its role short-code (rt/au/bs/other).

    Recognises both OCP layout (rgs-<env>-<role>) and the AWS EKS flat
    layout where the namespace is the bare role name.
    """
    if not ns_name:
        return "other"
    n = ns_name.lower()
    if n == "runtime" or n.endswith("-runtime"):                 return "rt"
    if n == "authoring" or n.endswith("-authoring"):             return "au"
    if n == "backingservices" or n.endswith("-backingservices"): return "bs"
    return "other"


def _get_product_versions_merged(cluster_id, namespaces):
    """
    Read product-versions ConfigMap from each namespace in `namespaces` and
    return BOTH the merged "latest" view AND a per-namespace breakdown.

    Why merged:
      * For c1d1 envs the pipeline writes to whichever namespace was actually
        deployed (authoring run -> authoring CM, runtime run -> runtime CM).
      * The dashboard's compact env table needs ONE value per product/env.

    Why per-namespace:
      * Common products (baseline, d1_suite, mpp, csr, catalog) can hold
        DIFFERENT versions in different namespaces — the user must be able to
        drill in and see the actual deployed version per NS, not just a single
        merged value.

    Merge strategy: per-key, prefer the most recently updated non-empty value.
    Empty values never overwrite a non-empty value from any namespace.

    Return shape (extra fields are additive — existing callers reading
    flat keys like "baseline", "csr_hf", "last_update" continue to work):
        {
            "baseline": "<merged>", "baseline_hf": "<merged>",
            ... (all _PRODUCT_VERSION_KEYS and _PRODUCT_HF_KEYS),
            "last_update": "<latest across NSs>",
            "by_ns": {
                "rt": {"namespace": "...-runtime",        "baseline": "...", "baseline_hf": "...", "last_update": "..."},
                "au": {"namespace": "...-authoring",      "baseline": "...", ...},
                "bs": {"namespace": "...-backingservices","baseline": "...", ...},
            },
            "divergent": ["baseline", "csr"]  # keys with >1 distinct non-empty value across NSs
        }
    """
    # Parallelize the per-NS reads — was sequential, which made env-detail
    # take 3x the latency it needed for an env that has all 3 namespaces.
    real_ns = [ns for ns in namespaces if ns]
    if not real_ns:
        return _merge_product_versions_from_views([], {})
    if len(real_ns) == 1:
        ns_views = {real_ns[0]: _get_product_versions(cluster_id, real_ns[0])}
    else:
        with ThreadPoolExecutor(max_workers=len(real_ns)) as pool:
            futs = {ns: pool.submit(_get_product_versions, cluster_id, ns) for ns in real_ns}
            ns_views = {ns: f.result() for ns, f in futs.items()}
    return _merge_product_versions_from_views(real_ns, ns_views)


# ---------------------------------------------------------------------------
# Pods, nodes, ingress
# ---------------------------------------------------------------------------

def _list_pods_raw(cluster_id, namespace):
    """List pods for a namespace (no metrics). Separated for use with shared pool."""
    return _core_v1(cluster_id).list_namespaced_pod(namespace)


def _build_pod_list(pods_list, pod_metrics, namespace):
    """Transform a K8s pod list + metrics dict into our pod dict list."""
    pods = []
    for pod in pods_list.items:
        containers = pod.spec.containers or []
        total_cpu_req_m = 0
        total_cpu_lim_m = 0
        total_mem_req_bytes = 0
        total_mem_lim_bytes = 0
        cpu_req_str = cpu_lim_str = mem_req_str = mem_lim_str = "N/A"
        if containers:
            for c in containers:
                requests = (c.resources.requests or {}) if c.resources else {}
                limits = (c.resources.limits or {}) if c.resources else {}
                total_cpu_req_m += _parse_cpu(requests.get("cpu", "0"))
                total_cpu_lim_m += _parse_cpu(limits.get("cpu", "0"))
                total_mem_req_bytes += _parse_memory_bytes(requests.get("memory", "0"))
                total_mem_lim_bytes += _parse_memory_bytes(limits.get("memory", "0"))
            first = containers[0]
            r0 = (first.resources.requests or {}) if first.resources else {}
            l0 = (first.resources.limits or {}) if first.resources else {}
            cpu_req_str = r0.get("cpu", "N/A")
            cpu_lim_str = l0.get("cpu", "N/A")
            mem_req_str = r0.get("memory", "N/A")
            mem_lim_str = l0.get("memory", "N/A")

        labels = pod.metadata.labels or {}
        service = labels.get("app", labels.get("app.kubernetes.io/name",
                  pod.metadata.name.rsplit("-", 2)[0]))
        phase = pod.status.phase or "Unknown"
        container_statuses = pod.status.container_statuses or []
        restarts = sum(cs.restart_count for cs in container_statuses)
        ready_count = sum(1 for cs in container_statuses if cs.ready)
        total_count = len(container_statuses) if container_statuses else len(containers)
        status = phase
        for cs in container_statuses:
            if cs.state and cs.state.waiting and cs.state.waiting.reason:
                status = cs.state.waiting.reason
                break

        pm = pod_metrics.get(pod.metadata.name, {})
        cpu_used_m = pm.get("cpu_m", 0)
        mem_used_bytes = pm.get("mem_bytes", 0)
        ref_cpu = total_cpu_lim_m if total_cpu_lim_m > 0 else total_cpu_req_m
        ref_mem = total_mem_lim_bytes if total_mem_lim_bytes > 0 else total_mem_req_bytes
        cpu_pct = round(cpu_used_m / ref_cpu * 100, 1) if ref_cpu > 0 else 0
        mem_pct = round(mem_used_bytes / ref_mem * 100, 1) if ref_mem > 0 else 0
        mem_used_display = f"{round(mem_used_bytes / (1024**2), 1)} Mi" if mem_used_bytes > 0 else "0"

        pods.append({
            "name": pod.metadata.name,
            "service": service,
            "service_type": "microservice",
            "status": status,
            "restarts": restarts,
            "ready": f"{ready_count}/{total_count}",
            "cpu_request": cpu_req_str, "cpu_limit": cpu_lim_str,
            "mem_request": mem_req_str, "mem_limit": mem_lim_str,
            "cpu_usage_pct": cpu_pct, "mem_usage_pct": mem_pct,
            "cpu_usage_m": cpu_used_m, "mem_usage_display": mem_used_display,
            "node": pod.spec.node_name or "N/A",
            "namespace": namespace,
        })
    return pods


def get_pods_for_namespace(cluster_id, namespace):
    """Standalone version — used by external callers."""
    pods_list = _list_pods_raw(cluster_id, namespace)
    pod_metrics = _get_pod_metrics(cluster_id, namespace)
    return _build_pod_list(pods_list, pod_metrics, namespace)


def _count_pods_per_node(cluster_id):
    """Count running pods per node without loading full pod objects into memory."""
    pods_per_node = {}
    try:
        v1 = _core_v1(cluster_id)
        _continue = None
        while True:
            kwargs = {
                "field_selector": "status.phase=Running",
                "limit": 2000,
                "_preload_content": False,
                "_request_timeout": 20,
            }
            if _continue:
                kwargs["_continue"] = _continue
            resp = v1.list_pod_for_all_namespaces(**kwargs)
            data = json.loads(resp.read())
            for item in data.get("items", []):
                nn = (item.get("spec") or {}).get("nodeName")
                if nn:
                    pods_per_node[nn] = pods_per_node.get(nn, 0) + 1
            _continue = (data.get("metadata") or {}).get("continue")
            if not _continue:
                break
    except Exception as e:
        log.warning("Failed to count pods per node for %s: %s", cluster_id, e)
    return pods_per_node


def get_nodes(cluster_id):
    _get_api_client(cluster_id)
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_nodes = pool.submit(lambda: _core_v1(cluster_id).list_node(_request_timeout=15))
        f_metrics = pool.submit(_get_node_metrics, cluster_id)
        f_pod_counts = pool.submit(_count_pods_per_node, cluster_id)
    try:
        nodes_list = f_nodes.result(timeout=20)
    except Exception as e:
        log.error("Failed to list nodes for cluster %s: %s", cluster_id, e)
        return []
    try:
        node_metrics = f_metrics.result(timeout=15)
    except Exception:
        node_metrics = {}
    try:
        pods_per_node = f_pod_counts.result(timeout=20)
    except Exception:
        pods_per_node = {}
    nodes = []
    for node in nodes_list.items:
        labels = node.metadata.labels or {}
        role = "worker"
        for lbl in labels:
            if lbl.startswith("node-role.kubernetes.io/"):
                role = lbl.split("/", 1)[1]
                if role == "control-plane":
                    role = "master"
                break
        status = "Unknown"
        for cond in (node.status.conditions or []):
            if cond.type == "Ready":
                status = "Ready" if cond.status == "True" else "NotReady"
                break
        capacity = node.status.capacity or {}

        cpu_cap_str = capacity.get("cpu", "N/A")
        mem_cap_str = capacity.get("memory", "N/A")
        cpu_cap_m = _parse_cpu(cpu_cap_str)
        mem_cap_bytes = _parse_memory_bytes(mem_cap_str)

        nm = node_metrics.get(node.metadata.name, {})
        cpu_used_m = nm.get("cpu_m", 0)
        mem_used_bytes = nm.get("mem_bytes", 0)
        cpu_pct = round(cpu_used_m / cpu_cap_m * 100, 1) if cpu_cap_m > 0 else 0
        mem_pct = round(mem_used_bytes / mem_cap_bytes * 100, 1) if mem_cap_bytes > 0 else 0

        mem_cap_display = mem_cap_str
        if mem_cap_bytes > 0:
            mem_cap_display = f"{round(mem_cap_bytes / (1024**3), 1)} Gi"

        nodes.append({
            "name": node.metadata.name,
            "role": role,
            "status": status,
            "cpu_capacity": cpu_cap_str,
            "mem_capacity": mem_cap_display,
            "cpu_usage_pct": cpu_pct, "mem_usage_pct": mem_pct,
            "pods_count": pods_per_node.get(node.metadata.name, 0),
            "os_image": node.status.node_info.os_image if node.status.node_info else "N/A",
            "kubelet_version": node.status.node_info.kubelet_version if node.status.node_info else "N/A",
        })
    return nodes


def get_ingress_urls(cluster_id, namespace):
    try:
        nv1 = _networking_v1(cluster_id)
        ingresses = nv1.list_namespaced_ingress(namespace)
        urls = []
        for ing in ingresses.items:
            for rule in (ing.spec.rules or []):
                host = rule.host or "N/A"
                for path in (rule.http.paths if rule.http else []):
                    urls.append({
                        "name": ing.metadata.name,
                        "namespace": namespace.split("-")[-1],
                        "host": host,
                        "path": path.path or "/",
                        "tls": bool(ing.spec.tls),
                    })
        return urls
    except Exception:
        return []


def get_routes(cluster_id, namespace):
    try:
        co = _custom_objects(cluster_id)
        routes = co.list_namespaced_custom_object(
            group="route.openshift.io", version="v1",
            namespace=namespace, plural="routes",
        )
        urls = []
        for route in routes.get("items", []):
            spec = route.get("spec", {})
            urls.append({
                "name": route["metadata"]["name"],
                "namespace": namespace.split("-")[-1],
                "host": spec.get("host", "N/A"),
                "path": spec.get("path", "/"),
                "tls": bool(spec.get("tls")),
            })
        return urls
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Environment summary (fast — metadata, sanity, deployments only, no pods)
# ---------------------------------------------------------------------------

def _count_pods_fast(cluster_id, namespace):
    """
    Lightweight pod counter: lists pods without metrics. Returns
    {pod_count, running_count, failed_count, unhealthy} — the cheap
    summary view used by the env-detail page so the stat cards and
    'Unhealthy pods' callout render instantly without paying the cost
    of fetching per-pod metrics.

    `unhealthy` is a small list of {name, status, ready, restarts,
    namespace} for pods NOT in {Running, Succeeded, Completed}, capped
    at MAX_UNHEALTHY_PER_NS so a misbehaving env can't blow up the
    payload size.
    """
    MAX_UNHEALTHY_PER_NS = 25
    try:
        pods = _list_pods_raw(cluster_id, namespace)
        items = pods.items or []
        running = 0
        failed = 0
        unhealthy = []
        healthy_set = {"Running", "Succeeded", "Completed"}
        for p in items:
            phase = (p.status.phase if p.status else None) or ""
            if phase == "Running":
                running += 1
            if phase not in healthy_set:
                failed += 1
                if len(unhealthy) < MAX_UNHEALTHY_PER_NS:
                    cs = (p.status.container_statuses or []) if p.status else []
                    ready = sum(1 for c in cs if c.ready)
                    total = len(cs)
                    restarts = sum((c.restart_count or 0) for c in cs)
                    # Try to surface a useful reason from container waiting state
                    reason = ""
                    for c in cs:
                        if c.state and c.state.waiting and c.state.waiting.reason:
                            reason = c.state.waiting.reason
                            break
                    unhealthy.append({
                        "name": p.metadata.name,
                        "namespace": namespace,
                        "status": phase or reason or "Unknown",
                        "reason": reason,
                        "ready": f"{ready}/{total}" if total else "0/0",
                        "restarts": restarts,
                    })
        return {
            "pod_count": len(items),
            "running_count": running,
            "failed_count": failed,
            "unhealthy": unhealthy,
        }
    except Exception:
        return {"pod_count": 0, "running_count": 0, "failed_count": 0, "unhealthy": []}


_env_summary_cache = {}
_env_summary_cache_lock = threading.Lock()
_ENV_SUMMARY_CACHE_TTL = 20  # seconds


def get_env_summary(dc, env_id):
    """Return env metadata, sanity, deployments, catalog, ingress + pod COUNTS only.

    Uses a short in-memory cache (20s TTL) so rapid navigation or
    accidental double-clicks don't re-hit the K8s API.
    """
    import time as _time
    cache_key = f"{dc}:{env_id}"
    now = _time.time()
    with _env_summary_cache_lock:
        entry = _env_summary_cache.get(cache_key)
        if entry and (now - entry["ts"]) < _ENV_SUMMARY_CACHE_TTL:
            return entry["data"]

    cluster_id = dc
    prefix = f"rgs-{dc}-{env_id}"
    runtime_ns = f"{prefix}-runtime"
    authoring_ns = f"{prefix}-authoring"
    backing_ns = f"{prefix}-backingservices"
    all_ns = [runtime_ns, authoring_ns, backing_ns]

    _get_api_client(cluster_id)

    # All K8s reads submitted into one flat pool — no nesting, maximum
    # concurrency.  Ingress + routes split into separate tasks (2 per NS)
    # so they truly run in parallel instead of sequentially inside
    # _get_ingress_and_routes.
    with ThreadPoolExecutor(max_workers=20) as pool:
        f_meta = pool.submit(_get_env_metadata, cluster_id, runtime_ns)
        f_dep = {ns: pool.submit(_get_deployment_info, cluster_id, ns) for ns in all_ns}
        f_sanity = pool.submit(_get_sanity_with_history, cluster_id, runtime_ns)
        f_catalog = pool.submit(_get_catalog_data_files, cluster_id, runtime_ns)
        f_pv = {ns: pool.submit(_get_product_versions, cluster_id, ns) for ns in all_ns}
        f_ing = {ns: pool.submit(get_ingress_urls, cluster_id, ns) for ns in all_ns}
        f_routes = {ns: pool.submit(get_routes, cluster_id, ns) for ns in all_ns}
        f_counts = {ns: pool.submit(_count_pods_fast, cluster_id, ns) for ns in all_ns}

    ns_views = {ns: f_pv[ns].result() for ns in all_ns}
    pv = _merge_product_versions_from_views(all_ns, ns_views)

    ingress = []
    for ns in all_ns:
        try:
            ingress.extend(f_ing[ns].result())
        except Exception:
            pass
        try:
            ingress.extend(f_routes[ns].result())
        except Exception:
            pass

    counts = {}
    for ns in all_ns:
        try:
            counts[ns] = f_counts[ns].result()
        except Exception:
            counts[ns] = {"pod_count": 0, "running_count": 0, "failed_count": 0, "unhealthy": []}

    total = sum(c["pod_count"] for c in counts.values())
    running = sum(c["running_count"] for c in counts.values())
    failed = sum(c["failed_count"] for c in counts.values())
    unhealthy = []
    for c in counts.values():
        unhealthy.extend(c.get("unhealthy", []))

    result = {
        "environment": prefix,
        "datacenter": dc,
        "env_id": env_id,
        "env_metadata": f_meta.result(),
        "namespaces": {
            "runtime":         {"name": runtime_ns,   "deployment": f_dep[runtime_ns].result(),   **counts[runtime_ns]},
            "authoring":       {"name": authoring_ns, "deployment": f_dep[authoring_ns].result(), **counts[authoring_ns]},
            "backingservices": {"name": backing_ns,   "deployment": f_dep[backing_ns].result(),   **counts[backing_ns]},
        },
        "summary": {
            "total_pods":   total,
            "running_pods": running,
            "failed_pods":  failed,
            "health_pct":   round((total - failed) / total * 100, 1) if total > 0 else 0,
        },
        "unhealthy_pods": unhealthy,
        "ingress": ingress,
        "sanity": f_sanity.result(),
        "catalog_data_files": f_catalog.result(),
        "product_versions": pv,
    }

    with _env_summary_cache_lock:
        _env_summary_cache[cache_key] = {"ts": _time.time(), "data": result}

    return result


# ---------------------------------------------------------------------------
# Environment pods (heavier — pod lists + metrics)
# ---------------------------------------------------------------------------

def get_env_pods(dc, env_id):
    """Return pod lists + metrics for all 3 namespaces."""
    cluster_id = dc
    prefix = f"rgs-{dc}-{env_id}"
    runtime_ns = f"{prefix}-runtime"
    authoring_ns = f"{prefix}-authoring"
    backing_ns = f"{prefix}-backingservices"
    all_ns = [runtime_ns, authoring_ns, backing_ns]

    _get_api_client(cluster_id)

    with ThreadPoolExecutor(max_workers=6) as pool:
        f_pods_raw = {ns: pool.submit(_list_pods_raw, cluster_id, ns) for ns in all_ns}
        f_pod_metrics = {ns: pool.submit(_get_pod_metrics, cluster_id, ns) for ns in all_ns}

    ns_pods = {}
    for ns in all_ns:
        pods_list = f_pods_raw[ns].result()
        metrics = f_pod_metrics[ns].result()
        ns_pods[ns] = _build_pod_list(pods_list, metrics, ns)

    runtime_pods = ns_pods[runtime_ns]
    authoring_pods = ns_pods[authoring_ns]
    backing_pods = ns_pods[backing_ns]
    all_pods = runtime_pods + authoring_pods + backing_pods

    healthy_statuses = {"Running", "Succeeded", "Completed"}
    running = sum(1 for p in all_pods if p["status"] == "Running")
    healthy = sum(1 for p in all_pods if p["status"] in healthy_statuses)
    total = len(all_pods)

    return {
        "namespaces": {
            "runtime": {"pods": runtime_pods, "pod_count": len(runtime_pods),
                        "running_count": sum(1 for p in runtime_pods if p["status"] == "Running")},
            "authoring": {"pods": authoring_pods, "pod_count": len(authoring_pods),
                          "running_count": sum(1 for p in authoring_pods if p["status"] == "Running")},
            "backingservices": {"pods": backing_pods, "pod_count": len(backing_pods),
                                "running_count": sum(1 for p in backing_pods if p["status"] == "Running")},
        },
        "summary": {
            "total_pods": total,
            "running_pods": running,
            "failed_pods": total - healthy,
            "health_pct": round(healthy / total * 100, 1) if total > 0 else 0,
        },
    }


# ---------------------------------------------------------------------------
# Full environment data (deepest drill-down — kept for backward compat)
# ---------------------------------------------------------------------------

def get_env_data(dc, env_id):
    cluster_id = dc
    prefix = f"rgs-{dc}-{env_id}"
    runtime_ns = f"{prefix}-runtime"
    authoring_ns = f"{prefix}-authoring"
    backing_ns = f"{prefix}-backingservices"
    all_ns = [runtime_ns, authoring_ns, backing_ns]

    _get_api_client(cluster_id)

    with ThreadPoolExecutor(max_workers=20) as pool:
        f_pods_raw = {ns: pool.submit(_list_pods_raw, cluster_id, ns) for ns in all_ns}
        f_pod_metrics = {ns: pool.submit(_get_pod_metrics, cluster_id, ns) for ns in all_ns}
        f_ing = {ns: pool.submit(get_ingress_urls, cluster_id, ns) for ns in all_ns}
        f_routes = {ns: pool.submit(get_routes, cluster_id, ns) for ns in all_ns}
        f_meta = pool.submit(_get_env_metadata, cluster_id, runtime_ns)
        f_dep = {ns: pool.submit(_get_deployment_info, cluster_id, ns) for ns in all_ns}
        f_sanity = pool.submit(_get_sanity_with_history, cluster_id, runtime_ns)
        f_catalog = pool.submit(_get_catalog_data_files, cluster_id, runtime_ns)
        f_pv = {ns: pool.submit(_get_product_versions, cluster_id, ns) for ns in all_ns}

    ns_views = {ns: f_pv[ns].result() for ns in all_ns}
    pv = _merge_product_versions_from_views(all_ns, ns_views)

    ns_pods = {}
    for ns in all_ns:
        pods_list = f_pods_raw[ns].result()
        metrics = f_pod_metrics[ns].result()
        ns_pods[ns] = _build_pod_list(pods_list, metrics, ns)

    runtime_pods = ns_pods[runtime_ns]
    authoring_pods = ns_pods[authoring_ns]
    backing_pods = ns_pods[backing_ns]

    all_pods = runtime_pods + authoring_pods + backing_pods
    healthy_statuses = {"Running", "Succeeded", "Completed"}
    running = sum(1 for p in all_pods if p["status"] == "Running")
    healthy = sum(1 for p in all_pods if p["status"] in healthy_statuses)
    total = len(all_pods)

    ingress = []
    for ns in all_ns:
        try:
            ingress.extend(f_ing[ns].result())
        except Exception:
            pass
        try:
            ingress.extend(f_routes[ns].result())
        except Exception:
            pass

    return {
        "environment": prefix,
        "datacenter": dc,
        "env_id": env_id,
        "env_metadata": f_meta.result(),
        "namespaces": {
            "runtime": {
                "name": runtime_ns, "pods": runtime_pods,
                "pod_count": len(runtime_pods),
                "running_count": sum(1 for p in runtime_pods if p["status"] == "Running"),
                "deployment": f_dep[runtime_ns].result(),
            },
            "authoring": {
                "name": authoring_ns, "pods": authoring_pods,
                "pod_count": len(authoring_pods),
                "running_count": sum(1 for p in authoring_pods if p["status"] == "Running"),
                "deployment": f_dep[authoring_ns].result(),
            },
            "backingservices": {
                "name": backing_ns, "pods": backing_pods,
                "pod_count": len(backing_pods),
                "running_count": sum(1 for p in backing_pods if p["status"] == "Running"),
                "deployment": f_dep[backing_ns].result(),
            },
        },
        "summary": {
            "total_pods": total,
            "running_pods": running,
            "failed_pods": total - healthy,
            "health_pct": round(healthy / total * 100, 1) if total > 0 else 0,
        },
        "ingress": ingress,
        "sanity": f_sanity.result(),
        "catalog_data_files": f_catalog.result(),
        "product_versions": pv,
    }


# ---------------------------------------------------------------------------
# All environments table (flat list for table view)
# ---------------------------------------------------------------------------

_env_table_cache = {}
_env_table_cache_lock = threading.Lock()
_ENV_TABLE_CACHE_TTL = 30  # seconds


def _get_envs_for_cluster_table(cid):
    """Fetch environments with metadata and sanity data for a single cluster.

    Uses a short in-memory cache (30s TTL) to avoid hammering the K8s API
    on rapid browser refreshes.  Within a TTL window, the second and
    subsequent calls return instantly.
    """
    import time as _time
    now = _time.time()
    with _env_table_cache_lock:
        entry = _env_table_cache.get(cid)
        if entry and (now - entry["ts"]) < _ENV_TABLE_CACHE_TTL:
            return entry["data"]

    cfg = CLUSTERS_CONFIG.get(cid, {})
    cluster_name = cfg.get("full_name", cid)
    cluster_short = _pretty_short_name(cfg, cid)
    cloud = "aws" if (cfg.get("provider") or "").lower() == "aws" else "ocp"

    # _discover_environments_on_cluster already fetches metadata in parallel,
    # so the returned envs already carry owner/branch/drop/is_master.
    # No need for a second round of _get_env_metadata calls.
    envs = _discover_environments_on_cluster(cid)

    sanity_tasks = []
    for env in envs:
        runtime_ns = env["namespaces"].get("runtime", "")
        if runtime_ns:
            sanity_tasks.append((env["name"], cid, runtime_ns))

    sanity_map = {}
    pv_map = {}

    # Bulk-fetch product-versions CMs in ONE call.
    all_pv_data = _list_all_product_version_cms(cid)
    raw_views = {ns: _build_product_versions_view(data) for ns, data in all_pv_data.items()}
    pv_tasks = {
        env["name"]: [
            env["namespaces"].get("runtime", ""),
            env["namespaces"].get("authoring", ""),
            env["namespaces"].get("backingservices", ""),
        ]
        for env in envs
    }
    pv_fallback_futures = {}
    if not raw_views and envs:
        log.info("bulk product-versions list returned empty for %s — falling back to per-NS reads", cid)

    with ThreadPoolExecutor(max_workers=12) as pool:
        s_futures = {
            pool.submit(_get_sanity_data, c, ns): name
            for name, c, ns in sanity_tasks
        }
        if not raw_views and envs:
            pv_fallback_futures = {
                pool.submit(_get_product_versions_merged, cid, [n for n in nslist if n]): name
                for name, nslist in pv_tasks.items()
            }
        for fut in as_completed(s_futures):
            name = s_futures[fut]
            try:
                sanity_map[name] = fut.result()
            except Exception:
                sanity_map[name] = {}
    if pv_fallback_futures:
        for fut in as_completed(pv_fallback_futures):
            name = pv_fallback_futures[fut]
            try:
                pv_map[name] = fut.result()
            except Exception:
                pv_map[name] = {}
    else:
        for name, nslist in pv_tasks.items():
            try:
                real_ns = [n for n in nslist if n]
                pv_map[name] = _merge_product_versions_from_views(real_ns, raw_views)
            except Exception:
                pv_map[name] = {}

    result = []
    for env in envs:
        sanity = sanity_map.get(env["name"], {})
        pv = pv_map.get(env["name"], {}) or {}
        dv = env.get("drop_version", "")
        if not dv:
            dv = "N/A"
        result.append({
            "name": env["name"],
            "datacenter": env.get("datacenter", cid),
            "env_id": env.get("env_id", ""),
            "cluster": cluster_short,
            "cluster_full": cluster_name,
            "cluster_id": cid,
            "cloud": cloud,
            "drop_version": dv,
            "owner": env.get("env_owner", ""),
            "branch": env.get("bitbucket_branch", ""),
            "is_master": env.get("is_master", False),
            "last_update": max(sanity.get("last_run", "") or "", pv.get("last_update", "") or ""),
            "sanity_passrate": sanity.get("sanity_passrate", "N/A"),
            "sanity_passrate_value": sanity.get("sanity_passrate_value", 0),
            "sanity_total_tests": sanity.get("total_tests", ""),
            "sanity_passed_tests": sanity.get("passed_tests", ""),
            "sanity_failed_tests": sanity.get("failed_tests", ""),
            "sanity_jar_version": sanity.get("sanity_jar_version", ""),
            "triggered_by": sanity.get("triggered_by", ""),
            "product_versions": pv,
            "pv_baseline":   pv.get("baseline", ""),
            "pv_platform":   pv.get("platform", ""),
            "pv_catalog":    pv.get("catalog", ""),
            "pv_csr":        pv.get("csr", ""),
            "pv_oc":         pv.get("oc", ""),
            "pv_oh":         pv.get("oh", ""),
            "pv_care":       pv.get("care", ""),
            "pv_mass":       pv.get("mass", ""),
            "pv_backoffice": pv.get("backoffice", ""),
            "pv_d1_suite":   pv.get("d1_suite", ""),
            "pv_mpp":        pv.get("mpp", ""),
            "pv_baseline_hf":   pv.get("baseline_hf", ""),
            "pv_platform_hf":   pv.get("platform_hf", ""),
            "pv_catalog_hf":    pv.get("catalog_hf", ""),
            "pv_csr_hf":        pv.get("csr_hf", ""),
            "pv_oc_hf":         pv.get("oc_hf", ""),
            "pv_oh_hf":         pv.get("oh_hf", ""),
            "pv_care_hf":       pv.get("care_hf", ""),
            "pv_mass_hf":       pv.get("mass_hf", ""),
            "pv_backoffice_hf": pv.get("backoffice_hf", ""),
            "pv_by_ns":         pv.get("by_ns", {}) or {},
            "pv_divergent":     pv.get("divergent", []) or [],
        })

    with _env_table_cache_lock:
        _env_table_cache[cid] = {"ts": _time.time(), "data": result}

    return result


def get_all_environments_table(cluster_id=None):
    """Return a flat list of all environments with enriched metadata for the table view.

    Each entry is annotated with `cloud` = "ocp" or "aws" so the UI can filter
    by cloud provider without consulting the cluster config.
    """
    def _stamp_cloud(rows, cid):
        cloud = (CLUSTERS_CONFIG.get(cid, {}).get("provider") or "ocp").lower()
        for r in rows or []:
            r.setdefault("cloud", cloud)
        return rows

    if cluster_id:
        return _stamp_cloud(_get_envs_for_cluster_table(cluster_id), cluster_id)
    cluster_ids = list(CLUSTERS_CONFIG.keys())
    if len(cluster_ids) <= 1:
        return _stamp_cloud(_get_envs_for_cluster_table(cluster_ids[0]), cluster_ids[0]) if cluster_ids else []
    result = []
    with ThreadPoolExecutor(max_workers=len(cluster_ids)) as pool:
        futures = {pool.submit(_get_envs_for_cluster_table, cid): cid for cid in cluster_ids}
        for f in as_completed(futures):
            cid = futures[f]
            try:
                result.extend(_stamp_cloud(f.result(), cid))
            except Exception as e:
                log.warning("Failed to get env table for %s: %s", cid, e, exc_info=True)
    return result


# ---------------------------------------------------------------------------
# Owner update
# ---------------------------------------------------------------------------

def update_env_owner(cluster_id, env_base_name, new_owner):
    runtime_ns = f"{env_base_name}-runtime"
    v1 = _core_v1(cluster_id)
    try:
        cm = v1.read_namespaced_config_map(ENV_META_CONFIGMAP_NAME, runtime_ns)
        cm.data = cm.data or {}
        cm.data["env_owner"] = new_owner
        v1.patch_namespaced_config_map(ENV_META_CONFIGMAP_NAME, runtime_ns, cm)
    except client.exceptions.ApiException as e:
        if e.status == 404:
            body = client.V1ConfigMap(
                metadata=client.V1ObjectMeta(
                    name=ENV_META_CONFIGMAP_NAME,
                    labels={"app": "rogers-dashboard", "type": "metadata"},
                ),
                data={"env_owner": new_owner},
            )
            v1.create_namespaced_config_map(runtime_ns, body)
        else:
            raise
