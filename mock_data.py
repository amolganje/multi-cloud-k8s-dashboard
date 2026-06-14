"""
Mock data generator for development/demo without a live OCP cluster.
"""
import random

# ---------------------------------------------------------------------------
# Mock quick links — mirrors the real dashboard-config.yaml quick-links.json
# ---------------------------------------------------------------------------
MOCK_QUICK_LINKS = {
    "dvc": {
        "label": "DevOps Tools",
        "icon": "wrench",
        "links": [
            {"label": "DVC Jenkins",  "url": "http://jenkins.example.com:8080",                                                                     "icon": "jenkins"},
            {"label": "BitBucket",    "url": "https://git.example.com/projects/CHATDO/repos/env-manager",                                  "icon": "git"},
            {"label": "DVC Nexus",    "url": "http://nexus.example.com:8081",                                                     "icon": "package"},
            {"label": "DMZ Nexus",    "url": "http://nexus-dmz.example.com:8081",                                                                     "icon": "package"},
            {"label": "OCP Upgrade",  "url": "http://jenkins-jobs.example.com:41244/view/Upgrade/job/Openshift_Upgrade",                                "icon": "upgrade"},
            {"label": "CRD Update",   "url": "http://jenkins-jobs.example.com:41244/view/CRD%20Upgrade/job/CRD%20Upgrade%20Self%20Service/build?delay=0sec", "icon": "wrench"},
        ],
    },
    "aws": {
        "label": "AWS Tools",
        "icon": "aws",
        "links": [
            {"label": "AWS Jenkins",    "url": "https://jenkins-aws.example.com:8080",  "icon": "jenkins"},
            {"label": "AWS Nexus",      "url": "http://nexus-aws.example.com",                          "icon": "package"},
            {"label": "AWS Console",    "url": "https://portal.example.com",         "icon": "aws"},
            {"label": "AWS CheckPoint", "url": "https://mfa.example.com",                           "icon": "checkpoint"},
        ],
    },
}

# ---- Cluster Definitions ----
# Each cluster has: full_name, short_name (used in env naming), console URL, OCP version, status
CLUSTERS = {
    "dc01": {
        "cloud": "ocp",
        "full_name": "prodocpcluster401",
        "short_name": "ocp-401",
        "console_url": "https://console-openshift-console.apps.prodocpcluster401.ocp.example.com/",
        "api_url": "https://api.prodocpcluster401.ocp.example.com:6443",
        "ocp_version": "4.15.12",
        "region": "US - East",
        "provider": "VMware vSphere",
        "status": "Healthy",
    },
    "dc02": {
        "cloud": "ocp",
        "full_name": "prodocpcluster402",
        "short_name": "ocp-402",
        "console_url": "https://console-openshift-console.apps.prodocpcluster402.ocp.example.com/",
        "api_url": "https://api.prodocpcluster402.ocp.example.com:6443",
        "ocp_version": "4.14.35",
        "region": "US - East",
        "provider": "VMware vSphere",
        "status": "Healthy",
    },
    "dc03": {
        "cloud": "ocp",
        "full_name": "prodocpcluster403",
        "short_name": "ocp-403",
        "console_url": "https://console-openshift-console.apps.prodocpcluster403.ocp.example.com/",
        "api_url": "https://api.prodocpcluster403.ocp.example.com:6443",
        "ocp_version": "4.15.8",
        "region": "US - West",
        "provider": "Bare Metal",
        "status": "Healthy",
    },
    # ---- AWS EKS clusters (auto-discovered in live mode) ----
    "eks-dev-01": {
        "cloud": "aws",
        "full_name": "vpc002-aws5-dev",
        "short_name": "aws5",
        "console_url": "http://headlamp.vpc002-aws5-dev.eks.example.com",
        "headlamp_url": "http://headlamp.vpc002-aws5-dev.eks.example.com",
        "api_url": "https://ABCDEF1234.gr7.us-east-1.eks.amazonaws.com",
        "ocp_version": "v1.30",
        "region": "us-east-1",
        "provider": "Amazon EKS",
        "status": "Healthy",
    },
    "eks-prod-01": {
        "cloud": "aws",
        "full_name": "vpc003-aws6-prod",
        "short_name": "aws6",
        "console_url": "http://headlamp.vpc003-aws6-prod.eks.example.com",
        "headlamp_url": "http://headlamp.vpc003-aws6-prod.eks.example.com",
        "api_url": "https://XYZ0987654.gr7.us-east-1.eks.amazonaws.com",
        "ocp_version": "v1.30",
        "region": "us-east-1",
        "provider": "Amazon EKS",
        "status": "Healthy",
    },
}

DATACENTERS = list(CLUSTERS.keys())

# Environments per cluster, grouped by drop version (raw 4-digit code)
CLUSTER_ENVS = {
    "dc01": {
        # Master environments (one per drop)
        "mst2503": {"drop": "2503", "owner": "Release", "branch": "release/25.03", "is_master": True},
        "mst2509": {"drop": "2509", "owner": "Release", "branch": "release/25.09", "is_master": True},
        "mst2603": {"drop": "2603", "owner": "Release", "branch": "release/26.03", "is_master": True},
        # Regular environments
        "env06": {"drop": "2503", "owner": "Performance", "branch": "release/25.03"},
        "env07": {"drop": "2503", "owner": "Integration", "branch": "release/25.03"},
        "env10": {"drop": "2503", "owner": "Developer", "branch": "release/25.03"},
        "env08": {"drop": "2509", "owner": "Catalog", "branch": "release/25.09"},
        "env11": {"drop": "2509", "owner": "Testing", "branch": "release/25.09"},
        "env09": {"drop": "2509", "owner": "DevOps", "branch": "feature/JIRA-4521-offer-redesign"},
        "env12": {"drop": "2603", "owner": "Developer", "branch": "release/26.03"},
        "env13": {"drop": "2603", "owner": "Testing", "branch": "release/26.03"},
        "env14": {"drop": "2603", "owner": "Catalog", "branch": "feature/JIRA-4890-catalog-v2"},
        "env15": {"drop": "2603", "owner": "DevOps", "branch": "release/26.03"},
    },
    "dc02": {
        "mst2503": {"drop": "2503", "owner": "Release", "branch": "release/25.03", "is_master": True},
        "mst2603": {"drop": "2603", "owner": "Release", "branch": "release/26.03", "is_master": True},
        "env20": {"drop": "2503", "owner": "QA", "branch": "release/25.03"},
        "env21": {"drop": "2503", "owner": "Staging", "branch": "release/25.03"},
        "env22": {"drop": "2603", "owner": "Developer", "branch": "release/26.03"},
        "env23": {"drop": "2603", "owner": "Testing", "branch": "release/26.03"},
        "env24": {"drop": "2603", "owner": "Pre-Prod", "branch": "release/26.03"},
    },
    "dc03": {
        "mst2509": {"drop": "2509", "owner": "Release", "branch": "release/25.09", "is_master": True},
        "mst2603": {"drop": "2603", "owner": "Release", "branch": "release/26.03", "is_master": True},
        "env30": {"drop": "2509", "owner": "Performance", "branch": "release/25.09"},
        "env31": {"drop": "2509", "owner": "Integration", "branch": "release/25.09"},
        "env32": {"drop": "2603", "owner": "Developer", "branch": "release/26.03"},
        "env33": {"drop": "2603", "owner": "Catalog", "branch": "feature/JIRA-5010-us-catalog"},
        "env34": {"drop": "2603", "owner": "DevOps", "branch": "release/26.03"},
    },
    # AWS EKS clusters: four environments each (aws1–aws4)
    "eks-dev-01": {
        "aws1": {"drop": "2603", "owner": "AWS Dev Team",  "branch": "release/26.03"},
        "aws2": {"drop": "2603", "owner": "AWS QA",        "branch": "release/26.03"},
        "aws3": {"drop": "2509", "owner": "AWS Staging",   "branch": "release/25.09"},
        "aws4": {"drop": "2509", "owner": "AWS Perf",      "branch": "feature/JIRA-5102-perf-tuning"},
    },
    "eks-prod-01": {
        "aws1": {"drop": "2603", "owner": "AWS Prod",      "branch": "release/26.03", "is_master": True},
        "aws2": {"drop": "2603", "owner": "AWS Pre-Prod",  "branch": "release/26.03"},
        "aws3": {"drop": "2509", "owner": "AWS Hotfix",    "branch": "hotfix/26.03.1"},
        "aws4": {"drop": "2509", "owner": "AWS DR",        "branch": "release/25.09"},
    },
}

# Backwards-compat: flat ENV_CONFIG for get_mock_env_data (merged from all clusters)
ENV_CONFIG = {}
for _dc, _envs in CLUSTER_ENVS.items():
    for _eid, _cfg in _envs.items():
        # prefix with dc to avoid collisions (e.g. mst2603 exists on multiple clusters)
        ENV_CONFIG[f"{_dc}:{_eid}"] = _cfg
        # also keep plain key for backwards compat with single-cluster lookups
        if _eid not in ENV_CONFIG:
            ENV_CONFIG[_eid] = _cfg

# Jenkins pipeline URLs per drop version
DROP_PIPELINES = {
    "2503": {
        "jenkins_deploy_pipeline": "https://jenkins.telecom.local/job/rgs-deploy-25.03/",
        "jenkins_automation_pipeline": "https://jenkins.telecom.local/job/rgs-automation-25.03/",
    },
    "2509": {
        "jenkins_deploy_pipeline": "https://jenkins.telecom.local/job/rgs-deploy-25.09/",
        "jenkins_automation_pipeline": "https://jenkins.telecom.local/job/rgs-automation-25.09/",
    },
    "2603": {
        "jenkins_deploy_pipeline": "https://jenkins.telecom.local/job/rgs-deploy-26.03/",
        "jenkins_automation_pipeline": "https://jenkins.telecom.local/job/rgs-automation-26.03/",
    },
}

SANITY_JAR_VERSIONS = [
    "3.8.1", "3.7.2", "3.9.0-SNAPSHOT", "3.8.0",
]

# Catalog data zip file versions
CUSTOM_DATA_ZIP_VERSIONS = [
    "custom_data_25.03.12.zip", "custom_data_25.03.15.zip",
    "custom_data_25.09.05.zip", "custom_data_25.09.08.zip",
    "custom_data_26.03.01.zip", "custom_data_26.03.04.zip",
    "custom_data_26.03.07.zip",
]
CUSTOM_BP_ZIP_VERSIONS = [
    "custom_bp_25.03.3.zip", "custom_bp_25.03.6.zip",
    "custom_bp_25.09.2.zip", "custom_bp_25.09.4.zip",
    "custom_bp_26.03.1.zip", "custom_bp_26.03.3.zip",
    "custom_bp_26.03.5.zip",
]

RUNTIME_MICROSERVICES = [
    "offer-service", "cart-service", "order-service", "pricing-engine",
    "notification-service", "customer-profile", "digital-channel-api",
    "product-catalog-bff", "eligibility-service", "recommendation-engine",
    "session-manager", "payment-gateway", "loyalty-service", "sms-gateway",
]

AUTHORING_MICROSERVICES = [
    "catalog-manager", "product-designer", "offer-designer", "rule-engine",
    "workflow-orchestrator", "template-manager", "approval-service",
    "versioning-service", "import-export-service", "audit-service",
]

BACKING_SERVICES = [
    ("postgres-primary", "postgres"), ("postgres-replica", "postgres"),
    ("kafka-broker-0", "kafka"), ("kafka-broker-1", "kafka"),
    ("kafka-broker-2", "kafka"), ("kafka-zookeeper-0", "kafka"),
    ("couchbase-node-0", "couchbase"), ("couchbase-node-1", "couchbase"),
    ("elasticsearch-master-0", "elasticsearch"),
    ("elasticsearch-data-0", "elasticsearch"), ("elasticsearch-data-1", "elasticsearch"),
    ("redis-master", "redis"), ("redis-replica", "redis"),
]


def _fmt_drop(raw):
    return f"{raw[:2]}.{raw[2:]}" if len(raw) == 4 else raw


def _rand_cpu():
    return f"{random.randint(10, 950)}m"

def _rand_mem():
    return f"{random.randint(64, 2048)}Mi"

def _rand_cpu_pct():
    return round(random.uniform(5.0, 85.0), 1)

def _rand_mem_pct():
    return round(random.uniform(15.0, 90.0), 1)

def _pod_status():
    r = random.random()
    if r < 0.85: return "Running"
    elif r < 0.93: return "CrashLoopBackOff"
    elif r < 0.97: return "Pending"
    else: return "Error"


def _make_pods(services, namespace, is_backing=False):
    pods = []
    for svc in services:
        name = svc[0] if is_backing else svc
        svc_type = svc[1] if is_backing else "microservice"
        replicas = random.choice([1, 2, 3]) if not is_backing else 1
        for _ in range(replicas):
            status = _pod_status()
            restarts = random.randint(0, 3) if status == "Running" else random.randint(1, 50)
            pods.append({
                "name": f"{name}-{random.randint(1000,9999)}-{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=5))}",
                "service": name, "service_type": svc_type, "status": status,
                "restarts": restarts,
                "ready": "1/1" if status == "Running" else "0/1",
                "cpu_request": _rand_cpu(), "cpu_limit": _rand_cpu(),
                "mem_request": _rand_mem(), "mem_limit": _rand_mem(),
                "cpu_usage_pct": _rand_cpu_pct(), "mem_usage_pct": _rand_mem_pct(),
                "node": f"worker-{random.randint(1, 6)}.ocp.telecom.local",
                "namespace": namespace,
            })
    return pods


def _make_nodes():
    nodes = []
    roles = ["master"]*3 + ["worker"]*6
    for i, role in enumerate(roles):
        nodes.append({
            "name": f"{role}-{i+1}.ocp.telecom.local", "role": role,
            "status": "Ready" if random.random() < 0.95 else "NotReady",
            "cpu_capacity": "16", "mem_capacity": "65536Mi",
            "cpu_usage_pct": _rand_cpu_pct(), "mem_usage_pct": _rand_mem_pct(),
            "pods_count": random.randint(15, 60),
            "os_image": "Red Hat Enterprise Linux CoreOS 416.94.202401121",
            "kubelet_version": "v1.28.6",
        })
    return nodes


def _make_catalog_data_files(env):
    """Generate catalog data file info deployed via Jenkins."""
    d, h, m = random.randint(5, 13), random.randint(0, 23), random.randint(0, 59)
    return {
        "custom_data_zip": random.choice(CUSTOM_DATA_ZIP_VERSIONS),
        "custom_bp_zip": random.choice(CUSTOM_BP_ZIP_VERSIONS),
        "deployed_by": random.choice(DEPLOY_TRIGGERED_BY),
        "deploy_timestamp": f"2026-02-{d:02d}T{h:02d}:{m:02d}:00Z",
        "jenkins_data_deploy_url": f"https://jenkins.telecom.local/job/rgs-catalog-data-{env}/job/main/{random.randint(10, 200)}/",
    }


def _make_ingress_urls(dc, env):
    base = f"{env}.{dc}.ocp.telecom.local"
    return [
        {"name": "digital-channel-api", "namespace": "runtime", "host": f"api.{base}", "path": "/api/v1/*", "tls": True},
        {"name": "offer-service", "namespace": "runtime", "host": f"offers.{base}", "path": "/offers/*", "tls": True},
        {"name": "cart-service", "namespace": "runtime", "host": f"cart.{base}", "path": "/cart/*", "tls": True},
        {"name": "order-service", "namespace": "runtime", "host": f"orders.{base}", "path": "/orders/*", "tls": True},
        {"name": "customer-profile", "namespace": "runtime", "host": f"customer.{base}", "path": "/profile/*", "tls": True},
        {"name": "catalog-manager", "namespace": "authoring", "host": f"catalog.{base}", "path": "/catalog/*", "tls": True},
        {"name": "product-designer", "namespace": "authoring", "host": f"designer.{base}", "path": "/designer/*", "tls": True},
        {"name": "offer-designer", "namespace": "authoring", "host": f"offer-designer.{base}", "path": "/offer-design/*", "tls": True},
        {"name": "kafka-ui", "namespace": "backingservices", "host": f"kafka-ui.{base}", "path": "/", "tls": False},
        {"name": "couchbase-ui", "namespace": "backingservices", "host": f"couchbase.{base}", "path": "/ui/*", "tls": False},
        {"name": "kibana", "namespace": "backingservices", "host": f"kibana.{base}", "path": "/", "tls": False},
    ]


DEPLOY_TRIGGERED_BY = [
    "Alex", "Maria", "Raj", "Sophie", "Ahmed", "David",
    "Elena", "Chris", "Priya", "Jenkins (auto)",
]


def _make_deployment_info(dc, env, ns_type):
    bn = random.randint(50, 500)
    st = random.choice(["SUCCESS", "SUCCESS", "SUCCESS", "FAILURE", "UNSTABLE"])
    d, h, m = random.randint(8, 13), random.randint(0, 23), random.randint(0, 59)
    return {
        "jenkins_deploy_url": f"https://jenkins.telecom.local/job/rgs-deploy-{env}-{ns_type}/job/main/{bn}/",
        "jenkins_deploy_build_number": str(bn),
        "jenkins_deploy_status": st,
        "jenkins_deploy_timestamp": f"2026-02-{d:02d}T{h:02d}:{m:02d}:00Z",
        "triggered_by": random.choice(DEPLOY_TRIGGERED_BY),
    }


def _make_sanity_single(env, build_offset=0):
    passrate = round(random.uniform(55.0, 100.0), 2)
    bn = random.randint(100, 999) - build_offset
    total = random.randint(200, 400)
    passed = int(passrate * total / 100)
    d = max(1, random.randint(10, 13) - build_offset)
    h, m = random.randint(0, 23), random.randint(0, 59)
    return {
        "sanity_passrate": f"{passrate}%",
        "sanity_passrate_value": passrate,
        "jenkins_build_url": f"https://jenkins.telecom.local/job/rgs-sanity-{env}/job/main/{bn}/",
        "jenkins_build_number": str(bn),
        "last_run": f"2026-02-{d:02d}T{h:02d}:{m:02d}:00Z",
        "total_tests": str(total),
        "passed_tests": str(passed),
        "failed_tests": str(total - passed),
        "suite": "smoke+regression",
        "sanity_jar_version": random.choice(SANITY_JAR_VERSIONS),
    }


def _make_sanity_with_history(env):
    """Return latest sanity + last 3 builds history."""
    latest = _make_sanity_single(env, 0)
    history = [_make_sanity_single(env, i + 1) for i in range(3)]
    latest["history"] = history
    return latest


# ---- Public API ----

def _mock_hf_summary(cluster_id, cloud):
    """Per-role HF / product-version summary for the cluster-level fleet card.

    Each cluster uses the "mst" (master) env as the reference.  Versions and
    HF numbers are deliberately varied so drift highlighting fires in the UI.

    Data shape mirrors what the real k8s_client produces from the
    product-versions ConfigMap.
    """
    # (rt_csr_ver, platform_ver, au_catalog_ver, csr_hf, oc_hf, care_hf, catalog_hf)
    CLUSTER_DATA = {
        "dc02":             ("25.09.011", "1.28.2", "25.09.011", 12, 12, 11, 11),
        "il04":             ("25.09.011", "1.28.2", "25.09.011", 12, 12, 11, 11),
        "il07":             ("25.09.012", "1.28.2", "25.09.011", 13, 13, 12, 11),
        "dc01":             ("25.09.011", "1.28.2", "25.09.008", 12, 12, 11,  8),
        "il1026":           ("25.09.012", "1.28.2", "25.09.012", 13, 13, 12, 12),
        "dc03":             ("25.09.012", "1.28.1", "25.09.011", 13, 13, 12, 11),
        "eks-dev-01":       ("25.09.012", "1.28.2", "25.09.008", 13, 13, 11,  8),
        "eks-prod-01":      ("25.09.011", "1.28.2", "25.09.008", 12, 12, 11,  8),
    }
    rt_ver, platform_ver, au_ver, csr_hf, oc_hf, care_hf, cat_hf = CLUSTER_DATA.get(
        cluster_id, ("25.09.011", "1.28.2", "25.09.011", 12, 12, 11, 11)
    )
    ns_pfx = "" if cloud == "aws" else "rgs-mst-"

    return {
        "rt": {
            "namespace":   f"{ns_pfx}runtime",
            "baseline":    "25.09.0",
            "platform":    platform_ver,
            "catalog":     "25.09.1",
            "d1_suite":    "25.09.008",
            "mpp":         "25.09.005",
            "csr":         rt_ver,         "csr_hf":         str(csr_hf),
            "oc":          rt_ver,         "oc_hf":          str(oc_hf),
            "oh":          "25.09.010",    "oh_hf":          str(csr_hf - 2),
            "care":        rt_ver,         "care_hf":        str(care_hf),
            "mass":        "25.09.009",    "mass_hf":        str(csr_hf - 3),
            "backoffice":  rt_ver,         "backoffice_hf":  str(csr_hf),
            "last_update": "2026-05-25T08:14:00Z",
        },
        "au": {
            "namespace":   f"{ns_pfx}authoring",
            "baseline":    "25.09.0",
            "platform":    platform_ver,
            "catalog":     au_ver,         "catalog_hf":     str(cat_hf),
            "d1_suite":    "25.09.008",
            "mpp":         "25.09.005",
            "last_update": "2026-05-25T08:14:00Z",
        },
        "bs": {
            "namespace":   f"{ns_pfx}backingservices",
            "baseline":    "25.09.0",
            "platform":    platform_ver,   "platform_hf":    "8",
            "d1_suite":    "25.09.008",
            "mpp":         "25.09.005",
            "last_update": "2026-05-25T08:14:00Z",
        },
        "any": True,
    }


def _node_roles_summary(nodes):
    """Aggregate node counts by role (used for the cluster card sub-stat)."""
    out = {}
    for n in nodes or []:
        r = n.get("role") or "worker"
        out[r] = out.get(r, 0) + 1
    return out


def _mock_ocp_nodes(cluster_id):
    """Realistic OCP-on-vSphere node list (3 masters + 6 workers)."""
    seed = sum(ord(c) for c in cluster_id)
    rows = []
    for i in range(3):
        rows.append({
            "name": f"{cluster_id}-master-{i}",
            "role": "master",
            "k8s_version": "v1.28.6",
            "os_image": "Red Hat Enterprise Linux CoreOS 415.92",
            "kernel": "5.14.0-284.59.1.el9_2.x86_64",
            "container_runtime": "cri-o://1.28.4-3.rhaos4.15",
            "instance_type": "vsphere-vm",
            "zone": f"vsphere-z{i+1}",
            "nodegroup": "control-plane",
            "capacity": {"cpu_m": 8000, "mem_bytes": 32 * 1024 * 1024 * 1024, "pods": 250},
            "allocatable": {"cpu_m": 7500, "mem_bytes": 30 * 1024 * 1024 * 1024},
            "usage": {"cpu_m": 2200 + (seed % 800), "mem_bytes": int(18 * 1024 * 1024 * 1024)},
            "status": "Ready",
        })
    cpu_used_pct = [62, 35, 81, 44, 19, 73]
    mem_used_pct = [71, 38, 64, 51, 22, 79]
    for i in range(6):
        rows.append({
            "name": f"{cluster_id}-worker-{i}",
            "role": "worker",
            "k8s_version": "v1.28.6",
            "os_image": "Red Hat Enterprise Linux CoreOS 415.92",
            "kernel": "5.14.0-284.59.1.el9_2.x86_64",
            "container_runtime": "cri-o://1.28.4-3.rhaos4.15",
            "instance_type": "vsphere-vm",
            "zone": f"vsphere-z{(i % 3) + 1}",
            "nodegroup": "worker-pool",
            "capacity": {"cpu_m": 16000, "mem_bytes": 64 * 1024 * 1024 * 1024, "pods": 250},
            "allocatable": {"cpu_m": 15500, "mem_bytes": 62 * 1024 * 1024 * 1024},
            "usage": {
                "cpu_m": int(16000 * cpu_used_pct[i] / 100),
                "mem_bytes": int(64 * 1024 * 1024 * 1024 * mem_used_pct[i] / 100),
            },
            "status": "Ready",
        })
    return rows


def _mock_ocp_services(cluster_full_name):
    """Generate the OCP service catalog with realistic Amdocs OCP route hosts.

    Produces cluster-level services (console, vault, argocd) plus per-env
    services for three environments (mst, env1, env2) so the multi-env
    grouping on the URLs tab is visible in mock mode.
    """
    base = f"apps.{cluster_full_name}.ocp.example.com"

    # Cluster-level (one per cluster, not tied to any env)
    cluster_level = [
        ("console",  "OpenShift Console", "openshift", "openshift-console",
         f"console-openshift-console.{base}"),
        ("vault",    "Vault",             "vault",     "vault",
         f"vault.{base}"),
        ("argocd",   "ArgoCD",            "argocd",    "openshift-argocd",
         f"argo-cd-argocd-server-openshift-argocd.{base}"),
    ]

    # Per-env services (same routes exist in every env namespace)
    # env_id → namespace pattern: rgs-<env_id>-<role>
    env_ids = ["mst-2509", "env1", "env2", "env3", "env5"]
    per_env_template = [
        ("keycloak",     "Keycloak",                "keycloak", "authoring"),
        ("apigw_au",     "API Gateway",  "apigw",   "authoring"),
        ("c1_web",       "C1 Web UI",                "c1web",   "authoring"),
        ("c1_dashboard", "C1 Dashboard",             "c1dash",  "authoring"),
        ("apigw_rt",     "API Gateway",    "apigw",   "runtime"),
        ("orderworkflow","OrderWorkflow",            "workflow","runtime"),
        ("backoffice",   "BackOffice",               "office",  "runtime"),
        ("sky",          "Sky Portal",               "sky",     "runtime"),
        ("couchbase",    "Couchbase",                "couchbase","backingservices"),
        ("elastic",      "Elasticsearch",            "elastic", "backingservices"),
        ("kafkaui",      "Kafka UI",                 "kafka",   "backingservices"),
    ]

    services = [
        {"key": key, "label": label, "icon": icon, "namespace": ns,
         "host": host, "url": f"https://{host}"}
        for (key, label, icon, ns, host) in cluster_level
    ]

    for env_id in env_ids:
        for key, label, icon, role in per_env_template:
            ns = f"rgs-{env_id}-{role}"
            host = f"{label.lower().replace(' ', '-').replace('(', '').replace(')', '')}-{ns}.{base}"
            # Use consistent meaningful host names
            if key == "keycloak":       host = f"keycloak-{ns}.{base}"
            elif key == "apigw_au":     host = f"amd-apigw-stack-service-{ns}.{base}"
            elif key == "c1_web":       host = f"c1-web-ui-{ns}.{base}"
            elif key == "c1_dashboard": host = f"c1-dashboard-{ns}.{base}"
            elif key == "apigw_rt":     host = f"amd-apigw-stack-service-{ns}.{base}"
            elif key == "orderworkflow":host = f"orderworkflow-orchestrator-service-{ns}.{base}"
            elif key == "backoffice":   host = f"backoffice-operation-{ns}.{base}"
            elif key == "sky":          host = f"o2aportalui-fe-service-{ns}.{base}"
            elif key == "couchbase":    host = f"d1-couchbase-01-ui-{ns}.{base}"
            elif key == "elastic":      host = f"elastic-enterprise-user-es-master-{ns}.{base}"
            elif key == "kafkaui":      host = f"kafka-ui-{ns}.{base}"
            services.append({
                "key": key, "label": label, "icon": icon,
                "namespace": ns, "host": host, "url": f"https://{host}",
            })

    return services


def _mock_aws_nodes(cluster_id):
    """Generate a realistic node detail list for a mock EKS cluster.

    Mirrors the real Rogers EKS node-group layout: an `application` worker
    pool plus dedicated `infra`, `ms360-infra`, and per-AZ `couchbase` /
    `elasticsearch` groups. Per-AZ groups (a/b/c) share the same `role`
    category so they roll up together in the node-count summary.
    """
    seed = sum(ord(c) for c in cluster_id)
    # (group, instance_type, cpu_m, mem_gi, az_suffix or None)
    plan = [
        *[("application", "m5.2xlarge", 8000, 32, None) for _ in range(10)],
        ("infra", "m5.xlarge", 4000, 16, None),
        ("ms360-infra", "m5.xlarge", 4000, 16, None),
        ("couchbase", "r5.xlarge", 4000, 32, "a"),
        ("couchbase", "r5.xlarge", 4000, 32, "b"),
        ("couchbase", "r5.xlarge", 4000, 32, "c"),
        ("elasticsearch", "r5.2xlarge", 8000, 64, "a"),
        ("elasticsearch", "r5.2xlarge", 8000, 64, "b"),
        ("elasticsearch", "r5.2xlarge", 8000, 64, "c"),
    ]
    azs = ["us-east-1a", "us-east-1b", "us-east-1c"]
    rows = []
    for i, (group, itype, cpu_m, mem_gi, az_suffix) in enumerate(plan):
        name = f"ip-100-68-{(seed + i) % 250}-{(seed * (i + 1)) % 250}.us-east-1.compute.internal"
        mem_b = mem_gi * 1024 * 1024 * 1024
        cpu_pct = 18 + ((seed + i * 7) % 70)
        mem_pct = 22 + ((seed + i * 11) % 65)
        ng_part = f"{group}-{az_suffix}" if az_suffix else group
        zone = azs[i % 3] if not az_suffix else f"us-east-1{az_suffix}"
        rows.append({
            "name": name,
            "role": group,
            "k8s_version": "v1.30.6",
            "os_image": "Amazon Linux 2",
            "kernel": "5.10.219-208.866.amzn2.x86_64",
            "container_runtime": "containerd://1.7.11",
            "instance_type": itype,
            "zone": zone,
            "nodegroup": f"{cluster_id}-{ng_part}-nodegroup-custom",
            "capacity": {"cpu_m": cpu_m, "mem_bytes": mem_b, "pods": 58},
            "allocatable": {"cpu_m": int(cpu_m * 0.95), "mem_bytes": int(mem_b * 0.93)},
            "usage": {
                "cpu_m": int(cpu_m * cpu_pct / 100),
                "mem_bytes": int(mem_b * mem_pct / 100),
            },
            "status": "Ready",
        })
    return rows


def _mock_aws_services(cluster_full_name):
    """Generate the EKS service catalog with realistic Rogers AWS host names.

    Four environments (aws1–aws4), each with runtime / authoring / backingservices
    namespaces prefixed by env name so the accordion grouping is visible in mock mode.
    Cluster-level services (Headlamp, ArgoCD) are added once without an env prefix.
    """
    base = cluster_full_name + ".eks.example.com"

    # Cluster-level (not tied to any env)
    cluster_level = [
        ("headlamp", "Headlamp (Cluster UI)", "headlamp", "headlamp", f"headlamp.{base}"),
        ("argocd",   "ArgoCD",               "argocd",   "argocd",   f"argo-cd-argocd-server-argocd.{base}"),
    ]

    env_ids = ["aws1", "aws2", "aws3", "aws4"]
    per_env_template = [
        ("keycloak",     "Keycloak",      "keycloak", "authoring"),
        ("apigw_au",     "API Gateway",   "apigw",    "authoring"),
        ("c1_web",       "C1 Web UI",     "c1web",    "authoring"),
        ("c1_dashboard", "C1 Dashboard",  "c1dash",   "authoring"),
        ("apigw_rt",     "API Gateway",   "apigw",    "runtime"),
        ("orderworkflow","OrderWorkflow", "workflow", "runtime"),
        ("backoffice",   "BackOffice",    "office",   "runtime"),
        ("sky",          "Sky Portal",    "sky",      "runtime"),
        ("couchbase",    "Couchbase",     "couchbase","backingservices"),
        ("elastic",      "Elasticsearch", "elastic",  "backingservices"),
        ("kafkaui",      "Kafka UI",      "kafka",    "backingservices"),
    ]

    host_fn = {
        "keycloak":      lambda ns: f"keycloak-{ns}.{base}",
        "apigw_au":      lambda ns: f"amd-apigw-stack-service-{ns}.{base}",
        "c1_web":        lambda ns: f"c1-web-ui-{ns}.{base}",
        "c1_dashboard":  lambda ns: f"c1-dashboard-{ns}.{base}",
        "apigw_rt":      lambda ns: f"amd-apigw-stack-service-{ns}.{base}",
        "orderworkflow": lambda ns: f"orderworkflow-orchestrator-service-{ns}.{base}",
        "backoffice":    lambda ns: f"backoffice-operation-{ns}.{base}",
        "sky":           lambda ns: f"o2aportalui-fe-service-{ns}.{base}",
        "couchbase":     lambda ns: f"d1-couchbase-01-ui-{ns}.{base}",
        "elastic":       lambda ns: f"elastic-enterprise-user-es-master-{ns}.{base}",
        "kafkaui":       lambda ns: f"kafka-ui-{ns}.{base}",
    }

    services = [
        {"key": key, "label": label, "icon": icon,
         "namespace": ns, "host": host, "url": f"https://{host}"}
        for (key, label, icon, ns, host) in cluster_level
    ]

    for env_id in env_ids:
        for key, label, icon, role in per_env_template:
            ns = f"{env_id}-{role}"
            host = host_fn[key](ns)
            services.append({
                "key": key, "label": label, "icon": icon,
                "namespace": ns, "host": host, "url": f"https://{host}",
            })

    return services


def get_mock_clusters_overview():
    """Return cluster list with summary stats for the top-level landing page."""
    clusters = []
    for dc_id, cluster in CLUSTERS.items():
        env_map = CLUSTER_ENVS.get(dc_id, {})
        total_envs = len(env_map)
        drop_set = set(cfg["drop"] for cfg in env_map.values())
        mock_crd = [
            {"name": "elastic-operator-crd", "chart": "elastic-operator-crd", "chart_version": "3.0.0", "revision": 19, "status": "deployed", "namespace": "ms360-platform-crd"},
            {"name": "kafka-operator-prerequisities", "chart": "kafka-operator-prerequisities", "chart_version": "3.1.1", "revision": 17, "status": "deployed", "namespace": "ms360-platform-crd"},
            {"name": "platform-istio-prerequisites", "chart": "platform-istio-prerequisites", "chart_version": "1.28.2", "revision": 33, "status": "deployed", "namespace": "ms360-platform-crd"},
            {"name": "platform-couchbase-operator-pre", "chart": "platform-couchbase-operator-pre", "chart_version": "2.10.6", "revision": 24, "status": "deployed", "namespace": "ms360-platform-crd"},
            {"name": "service-catalog", "chart": "service-catalog", "chart_version": "1.2.40", "revision": 14, "status": "deployed", "namespace": "ms360-platform-crd"},
        ]
        cloud = cluster.get("cloud", "ocp")
        if cloud == "aws":
            vault_url = ""
            argocd_url = f"https://argo-cd-argocd-server-argocd.{cluster['full_name']}.eks.example.com"
        else:
            vault_url = f"https://vault.apps.{cluster['full_name']}.ocp.example.com/"
            argocd_url = f"https://argo-cd-argocd-server-openshift-argocd.apps.{cluster['full_name']}.ocp.example.com/"
        if cloud == "aws":
            nodes = _mock_aws_nodes(dc_id)
            services = _mock_aws_services(cluster["full_name"])
        else:
            nodes = _mock_ocp_nodes(dc_id)
            services = _mock_ocp_services(cluster["full_name"])
        total_nodes = len(nodes)
        clusters.append({
            "cluster_id": dc_id,
            "full_name": cluster["full_name"],
            "short_name": cluster["short_name"],
            "console_url": cluster["console_url"],
            "headlamp_url": cluster.get("headlamp_url", ""),
            "api_url": cluster["api_url"],
            "vault_url": vault_url,
            "argocd_url": argocd_url,
            "crd_namespace": "ms360-platform-crd",
            "ocp_version": cluster["ocp_version"],
            "region": cluster["region"],
            "cloud": cloud,
            "provider": cluster["provider"],
            "status": cluster["status"],
            "total_nodes": total_nodes,
            "node_roles": _node_roles_summary(nodes) if nodes else {"worker": total_nodes},
            "nodes": nodes,
            "services": services,
            "hf_summary": _mock_hf_summary(dc_id, cloud),
            "total_envs": total_envs,
            "total_drops": len(drop_set),
            "drops": sorted([_fmt_drop(d) for d in drop_set], reverse=True),
            "crd_releases": mock_crd,
            "crd_total": len(mock_crd),
        })
    return clusters


# -----------------------------------------------------------------
# Per-drop base product versions used by pv_by_ns mock data
# -----------------------------------------------------------------
_DROP_PV_BASE = {
    "2503": {
        "baseline": "25.03.0", "platform": "1.27.4", "catalog": "25.03.1",
        "csr": "25.03.008", "oc": "25.03.008", "oh": "25.03.007",
        "care": "25.03.008", "mass": "25.03.006", "backoffice": "25.03.008",
        "d1_suite": "25.03.005", "mpp": "25.03.003",
    },
    "2509": {
        "baseline": "25.09.0", "platform": "1.28.2", "catalog": "25.09.1",
        "csr": "25.09.011", "oc": "25.09.011", "oh": "25.09.010",
        "care": "25.09.011", "mass": "25.09.009", "backoffice": "25.09.011",
        "d1_suite": "25.09.008", "mpp": "25.09.005",
    },
    "2603": {
        "baseline": "26.03.0", "platform": "1.29.1", "catalog": "26.03.1",
        "csr": "26.03.004", "oc": "26.03.004", "oh": "26.03.003",
        "care": "26.03.004", "mass": "26.03.003", "backoffice": "26.03.004",
        "d1_suite": "26.03.002", "mpp": "26.03.001",
    },
}

# HF numbers vary slightly per env (seed from the sum of char codes of env_id)
_HF_PRODUCTS = ["csr", "oc", "oh", "care", "mass", "backoffice", "catalog"]


def _mock_env_pv_by_ns(dc, env_id, drop_raw, flat_ns):
    """Build a per-namespace product-version map for one environment.

    Deliberately introduces:
    • Per-env HF variation (envs farther along the list have higher HF numbers)
    • Occasional RT/AU/BS catalog mismatch to trigger the ⚠ Mismatch badge
    """
    base = dict(_DROP_PV_BASE.get(drop_raw, _DROP_PV_BASE["2509"]))
    seed = sum(ord(c) for c in env_id) % 6
    def _bump(ver, delta):
        parts = ver.rsplit(".", 1)
        if len(parts) == 2 and parts[1].isdigit():
            return f"{parts[0]}.{int(parts[1]) + delta}"
        return ver
    env_delta = (seed % 3)
    for key in ("csr", "oc", "oh", "care", "mass", "backoffice", "d1_suite", "mpp"):
        if key in base:
            base[key] = _bump(base[key], env_delta)

    def _ns(role):
        if flat_ns:
            return role
        return f"rgs-{dc}-{env_id}-{role}"

    # HF deltas per product — vary across envs so some are ahead/behind
    hf_delta = {
        "csr": seed + 8, "oc": seed + 8, "oh": seed + 7,
        "care": seed + 7, "mass": seed + 5, "backoffice": seed + 8,
        "catalog": seed + 7, "platform": 0,
    }

    # Simulate: env10/env20/env30 have catalog mismatch RT vs AU
    catalog_mismatch = env_id in ("env10", "env20", "env30", "env32", "env14")

    rt = {
        "namespace": _ns("runtime"),
        "last_update": f"2026-05-2{seed + 1}T0{seed}:14:00Z",
        "baseline":  base["baseline"],
        "platform":  base["platform"],
        "d1_suite":  base["d1_suite"],
        "mpp":       base["mpp"],
        "catalog":   base["catalog"],
        "csr":       base["csr"],    "csr_hf":       str(hf_delta["csr"]),
        "oc":        base["oc"],     "oc_hf":        str(hf_delta["oc"]),
        "oh":        base["oh"],     "oh_hf":        str(hf_delta["oh"]),
        "care":      base["care"],   "care_hf":      str(hf_delta["care"]),
        "mass":      base["mass"],   "mass_hf":      str(hf_delta["mass"]),
        "backoffice":base["backoffice"], "backoffice_hf": str(hf_delta["backoffice"]),
    }
    # Authoring has catalog + keycloak; no CSR/OC etc.
    catalog_au = (base["catalog"].rsplit(".", 1)[0] + ".0") if catalog_mismatch else base["catalog"]
    au = {
        "namespace":  _ns("authoring"),
        "last_update": f"2026-05-2{seed + 1}T0{seed}:14:00Z",
        "baseline":  base["baseline"],
        "platform":  base["platform"],
        "d1_suite":  base["d1_suite"],
        "mpp":       base["mpp"],
        "catalog":   catalog_au,
        "catalog_hf": str(hf_delta["catalog"]) if not catalog_mismatch else str(max(0, hf_delta["catalog"] - 3)),
    }
    bs = {
        "namespace":  _ns("backingservices"),
        "last_update": f"2026-05-2{seed + 1}T0{seed}:14:00Z",
        "baseline":  base["baseline"],
        "platform":  base["platform"],
        "d1_suite":  base["d1_suite"],
        "mpp":       base["mpp"],
    }

    pv_by_ns = {"rt": rt, "au": au, "bs": bs}

    # Compute divergent products
    all_products = set(k for ns in (rt, au, bs) for k in ns
                       if k not in ("namespace", "last_update") and not k.endswith("_hf"))
    divergent = []
    for p in sorted(all_products):
        vals = [ns.get(p) for ns in (rt, au, bs) if ns.get(p)]
        if len(set(vals)) > 1:
            divergent.append(p)

    last_update = rt.get("last_update", "")
    return pv_by_ns, divergent, last_update


def get_mock_environments(cluster_id=None):
    """Return all environments with full summary metadata for the env-table view.

    Fields returned match what the frontend expects:
    cluster, name, datacenter, env_id, cloud, drop_version, branch, owner,
    is_master, sanity_*, pv_by_ns, pv_divergent, last_update.
    """
    envs = []
    dcs = [cluster_id] if cluster_id else DATACENTERS
    for dc in dcs:
        env_map = CLUSTER_ENVS.get(dc, {})
        cloud = CLUSTERS.get(dc, {}).get("cloud", "ocp")
        cluster_obj = CLUSTERS.get(dc, {})
        for env_id, cfg in env_map.items():
            flat_ns = cfg.get("flat_ns", False) or cloud == "aws"
            if flat_ns:
                name = env_id
                namespaces = {
                    "runtime": "runtime",
                    "authoring": "authoring",
                    "backingservices": "backingservices",
                }
            else:
                name = f"rgs-{dc}-{env_id}"
                namespaces = {
                    "runtime":       f"rgs-{dc}-{env_id}-runtime",
                    "authoring":     f"rgs-{dc}-{env_id}-authoring",
                    "backingservices": f"rgs-{dc}-{env_id}-backingservices",
                }

            sanity = _make_sanity_single(env_id)
            pv_by_ns, divergent, last_update = _mock_env_pv_by_ns(
                dc, env_id, cfg["drop"], flat_ns
            )

            envs.append({
                # Identity
                "name": name,
                "cluster": cluster_obj.get("short_name", dc),
                "cluster_full": cluster_obj.get("full_name", dc),
                "datacenter": dc,
                "env_id": env_id,
                "cloud": cloud,
                # Version / drop
                "drop_version": _fmt_drop(cfg["drop"]),
                "drop_version_raw": cfg["drop"],
                "is_master": cfg.get("is_master", False),
                # Ownership & branch
                "owner": cfg["owner"],
                "env_owner": cfg["owner"],          # kept for drops-view compat
                "branch": cfg["branch"],
                "bitbucket_branch": cfg["branch"],  # kept for drops-view compat
                # Sanity test results
                "sanity_passrate": sanity["sanity_passrate"],
                "sanity_passrate_value": sanity["sanity_passrate_value"],
                "sanity_passed_tests": sanity["passed_tests"],
                "sanity_total_tests": sanity["total_tests"],
                "sanity_jar_version": sanity["sanity_jar_version"],
                "sanity_build_url": sanity["jenkins_build_url"],
                "sanity_last_run": sanity["last_run"],
                # Product versions per namespace
                "pv_by_ns": pv_by_ns,
                "pv_divergent": divergent,
                "last_update": last_update,
                # Namespace map (for env-detail)
                "namespaces": namespaces,
            })
    return envs


def get_mock_drops_overview(cluster_id=None):
    """Return envs grouped by drop version with summary. Optionally filter by cluster."""
    all_envs = get_mock_environments(cluster_id)
    drops = {}
    for env in all_envs:
        dv = env["drop_version"]
        raw = env["drop_version_raw"]
        if dv not in drops:
            pipelines = DROP_PIPELINES.get(raw, {})
            drops[dv] = {
                "drop_version": dv,
                "drop_version_raw": raw,
                "jenkins_deploy_pipeline": pipelines.get("jenkins_deploy_pipeline", ""),
                "jenkins_automation_pipeline": pipelines.get("jenkins_automation_pipeline", ""),
                "environments": [],
            }
        # Quick summary per env (no heavy pod data)
        sanity = _make_sanity_single(env["env_id"])
        drops[dv]["environments"].append({
            "name": env["name"],
            "datacenter": env["datacenter"],
            "env_id": env["env_id"],
            "env_owner": env["env_owner"],
            "owner": env["env_owner"],
            "bitbucket_branch": env["bitbucket_branch"],
            "branch": env["bitbucket_branch"],
            "is_master": env.get("is_master", False),
            "sanity_passrate": sanity["sanity_passrate"],
            "sanity_passrate_value": sanity["sanity_passrate_value"],
            "sanity_passed_tests": sanity["passed_tests"],
            "sanity_total_tests": sanity["total_tests"],
            "sanity_jar_version": sanity["sanity_jar_version"],
            "sanity_build_url": sanity["jenkins_build_url"],
            "sanity_last_run": sanity["last_run"],
        })
    # Sort drops descending (newest first)
    return sorted(drops.values(), key=lambda d: d["drop_version_raw"], reverse=True)


def get_mock_env_data(dc, env):
    """Return full data for a single environment (the deepest drill-down)."""
    # Try cluster-specific lookup first, then fallback
    cluster_envs = CLUSTER_ENVS.get(dc, {})
    cfg = cluster_envs.get(env, ENV_CONFIG.get(env, {"drop": "2603", "owner": "Unknown", "branch": "main"}))
    prefix = f"rgs-{dc}-{env}"
    runtime_ns = f"{prefix}-runtime"
    authoring_ns = f"{prefix}-authoring"
    backing_ns = f"{prefix}-backingservices"

    runtime_pods = _make_pods(RUNTIME_MICROSERVICES, runtime_ns)
    authoring_pods = _make_pods(AUTHORING_MICROSERVICES, authoring_ns)
    backing_pods = _make_pods(BACKING_SERVICES, backing_ns, is_backing=True)
    all_pods = runtime_pods + authoring_pods + backing_pods
    running = sum(1 for p in all_pods if p["status"] == "Running")
    total = len(all_pods)

    pipelines = DROP_PIPELINES.get(cfg["drop"], {})

    return {
        "environment": prefix,
        "datacenter": dc,
        "env_id": env,
        "env_metadata": {
            "drop_version": _fmt_drop(cfg["drop"]),
            "drop_version_raw": cfg["drop"],
            "bitbucket_branch": cfg["branch"],
            "bitbucket_repo_url": f"https://bitbucket.telecom.local/projects/RGS/repos/rgs-{env}/browse",
            "env_owner": cfg["owner"],
            "jenkins_deploy_pipeline": pipelines.get("jenkins_deploy_pipeline", ""),
            "jenkins_automation_pipeline": pipelines.get("jenkins_automation_pipeline", ""),
        },
        "namespaces": {
            "runtime": {
                "name": runtime_ns, "pods": runtime_pods,
                "pod_count": len(runtime_pods),
                "running_count": sum(1 for p in runtime_pods if p["status"] == "Running"),
                "deployment": _make_deployment_info(dc, env, "runtime"),
            },
            "authoring": {
                "name": authoring_ns, "pods": authoring_pods,
                "pod_count": len(authoring_pods),
                "running_count": sum(1 for p in authoring_pods if p["status"] == "Running"),
                "deployment": _make_deployment_info(dc, env, "authoring"),
            },
            "backingservices": {
                "name": backing_ns, "pods": backing_pods,
                "pod_count": len(backing_pods),
                "running_count": sum(1 for p in backing_pods if p["status"] == "Running"),
                "deployment": _make_deployment_info(dc, env, "backingservices"),
            },
        },
        "summary": {
            "total_pods": total, "running_pods": running,
            "failed_pods": total - running,
            "health_pct": round(running / total * 100, 1) if total > 0 else 0,
        },
        "nodes": _make_nodes(),
        "ingress": _make_ingress_urls(dc, env),
        "sanity": _make_sanity_with_history(env),
        "catalog_data_files": _make_catalog_data_files(env),
    }
