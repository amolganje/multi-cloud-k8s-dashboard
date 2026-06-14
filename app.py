"""
RGS OCP Dashboard - Flask Application
Supports mock mode (local dev) and live mode (multi-cluster OCP).
"""
import os
import sys
import time
import logging
import traceback
from flask import Flask, render_template, jsonify, request
from config import MOCK_MODE, FLASK_HOST, FLASK_PORT, FLASK_DEBUG, SANITY_PASS_THRESHOLD, QUICK_LINKS, CLUSTERS_CONFIG
from history_db import (
    init_db, save_pod_snapshot, save_node_snapshot,
    get_pod_history, get_node_history, get_resource_recommendations,
    cleanup_old_data, save_sanity_snapshot, get_sanity_history,
)

# Send all app + k8s_client/aws_client logs (INFO and above, incl. full
# tracebacks) to stdout so they show up in `oc logs`. force=True overrides any
# handler gunicorn may have installed. Set LOG_LEVEL=DEBUG for more detail.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    force=True,
)
log = logging.getLogger("app")

print(f"[Startup] MOCK_MODE={MOCK_MODE}, FLASK_DEBUG={FLASK_DEBUG}", flush=True)

app = Flask(__name__)
init_db()

if MOCK_MODE:
    from mock_data import (
        get_mock_environments, get_mock_env_data,
        get_mock_drops_overview, get_mock_clusters_overview,
    )
else:
    try:
        from k8s_client import (
            get_clusters_overview, discover_environments,
            get_drops_overview, get_env_data,
            get_env_summary, get_env_pods,
            update_env_owner, get_nodes,
            get_all_environments_table,
        )
        print("[Startup] k8s_client loaded successfully", flush=True)
    except Exception as e:
        # Do NOT exit — that would crash-loop the pod and hide the cause.
        # Keep the web process alive so /healthz stays green and the exact
        # error is visible in `oc logs` and returned by the API endpoints.
        log.error("Failed to import k8s_client (API calls will report this): %s",
                  e, exc_info=True)
        _k8s_import_error = e

        def _k8s_unavailable(*_args, **_kwargs):
            raise RuntimeError(f"k8s_client failed to load: {_k8s_import_error}")

        get_clusters_overview = discover_environments = get_drops_overview = \
            get_env_data = get_env_summary = get_env_pods = update_env_owner = \
            get_nodes = get_all_environments_table = _k8s_unavailable


# Cache-busting version string for static assets. We use the latest mtime
# of any tracked static file at process start (i.e. fresh pod = fresh value).
# This forces browsers/CDNs to fetch the new dashboard.js/css when the pod
# is rebuilt, even if the URL path itself didn't change.
def _compute_assets_version():
    try:
        static_root = os.path.join(os.path.dirname(__file__), "static")
        latest = 0
        for root, _, files in os.walk(static_root):
            for fn in files:
                if fn.endswith((".js", ".css")):
                    try:
                        m = os.path.getmtime(os.path.join(root, fn))
                        if m > latest:
                            latest = m
                    except OSError:
                        pass
        return str(int(latest)) if latest else str(int(time.time()))
    except Exception:
        return str(int(time.time()))

ASSETS_VERSION = _compute_assets_version()
print(f"[Startup] ASSETS_VERSION={ASSETS_VERSION}", flush=True)


@app.context_processor
def _inject_assets_version():
    return {"ASSETS_VERSION": ASSETS_VERSION}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    # Liveness/readiness probe target. Stays cheap and never touches clusters
    # so probe health reflects the web process, not upstream connectivity.
    return jsonify({"status": "ok"}), 200


@app.route("/api/clusters")
def api_clusters():
    try:
        if MOCK_MODE:
            data = get_mock_clusters_overview()
        else:
            data = get_clusters_overview()
        return jsonify({"clusters": data})
    except Exception as e:
        print(f"[ERROR] api_clusters failed: {e}", flush=True)
        traceback.print_exc()
        return jsonify({"clusters": [], "error": str(e)}), 200


@app.route("/api/drops")
@app.route("/api/drops/<cluster_id>")
def api_drops(cluster_id=None):
    if MOCK_MODE:
        data = get_mock_drops_overview(cluster_id)
    else:
        data = get_drops_overview(cluster_id)
    return jsonify({"drops": data, "threshold": SANITY_PASS_THRESHOLD})


@app.route("/api/environments")
def api_environments():
    cluster_id = request.args.get("cluster_id")
    if MOCK_MODE:
        envs = get_mock_environments(cluster_id)
    else:
        envs = discover_environments(cluster_id)
    return jsonify({"environments": envs, "threshold": SANITY_PASS_THRESHOLD})


@app.route("/api/env/<dc>/<env_id>")
def api_env_data(dc, env_id):
    if MOCK_MODE:
        data = get_mock_env_data(dc, env_id)
    else:
        data = get_env_data(dc, env_id)
    data["threshold"] = SANITY_PASS_THRESHOLD

    try:
        save_pod_snapshot(data)
        save_sanity_snapshot(data)
    except Exception as e:
        print(f"Warning: Failed to save history snapshot: {e}")

    return jsonify(data)


@app.route("/api/env/<dc>/<env_id>/summary")
def api_env_summary(dc, env_id):
    """Fast endpoint: metadata, sanity, deployments, ingress — no pod lists."""
    if MOCK_MODE:
        data = get_mock_env_data(dc, env_id)
    else:
        data = get_env_summary(dc, env_id)
    data["threshold"] = SANITY_PASS_THRESHOLD
    return jsonify(data)


@app.route("/api/env/<dc>/<env_id>/pods")
def api_env_pods(dc, env_id):
    """Heavier endpoint: pod lists + metrics for all namespaces."""
    if MOCK_MODE:
        data = get_mock_env_data(dc, env_id)
        return jsonify({"namespaces": data.get("namespaces", {}), "summary": data.get("summary", {})})
    data = get_env_pods(dc, env_id)
    return jsonify(data)


@app.route("/api/cluster/<cluster_id>/nodes")
def api_cluster_nodes(cluster_id):
    if MOCK_MODE:
        return jsonify({"nodes": []})
    try:
        print(f"[INFO] get_nodes({cluster_id}) starting...", flush=True)
        nodes = get_nodes(cluster_id)
        print(f"[INFO] get_nodes({cluster_id}) returned {len(nodes)} nodes", flush=True)
        try:
            save_node_snapshot(nodes)
        except Exception:
            pass
        return jsonify({"nodes": nodes})
    except Exception as e:
        print(f"[ERROR] get_nodes({cluster_id}) failed: {e}", flush=True)
        traceback.print_exc()
        return jsonify({"nodes": [], "error": str(e)}), 200


@app.route("/api/debug/ns-annotations/<dc>/<env_id>")
def api_debug_ns_annotations(dc, env_id):
    """Temporary debug endpoint to inspect namespace annotations."""
    if MOCK_MODE:
        return jsonify({"error": "not available in mock mode"})
    from k8s_client import _core_v1
    prefix = f"rgs-{dc}-{env_id}"
    result = {}
    for suffix in ["runtime", "authoring", "backingservices"]:
        ns_name = f"{prefix}-{suffix}"
        try:
            v1 = _core_v1(dc)
            ns_obj = v1.read_namespace(ns_name)
            ann = ns_obj.metadata.annotations or {}
            result[ns_name] = {k: v for k, v in ann.items() if "openshift" in k.lower() or "display" in k.lower() or "description" in k.lower()}
        except Exception as e:
            result[ns_name] = {"error": str(e)}
    return jsonify(result)


@app.route("/api/config/quick-links")
def api_quick_links():
    if MOCK_MODE:
        from mock_data import MOCK_QUICK_LINKS
        return jsonify({"links": MOCK_QUICK_LINKS})
    links = None
    try:
        from kubernetes import client as k8s_client_mod
        from k8s_client import _get_api_client
        import json as _json
        first_cluster = next(iter(CLUSTERS_CONFIG), None)
        if first_cluster:
            api = k8s_client_mod.CoreV1Api(_get_api_client(first_cluster))
            cm = api.read_namespaced_config_map("rogers-dashboard-config", "rogers-dashboard")
            raw = (cm.data or {}).get("quick-links.json", "")
            if raw:
                links = _json.loads(raw)
    except Exception as e:
        print(f"[quick-links] Failed to read from ConfigMap: {e}", flush=True)
    if links is None:
        links = QUICK_LINKS
    return jsonify({"links": links})


@app.route("/api/environments/table")
@app.route("/api/environments/table/<cluster_id>")
def api_environments_table(cluster_id=None):
    if MOCK_MODE:
        envs = get_mock_environments(cluster_id)
        return jsonify({"environments": envs, "threshold": SANITY_PASS_THRESHOLD})
    data = get_all_environments_table(cluster_id)
    return jsonify({"environments": data, "threshold": SANITY_PASS_THRESHOLD})


@app.route("/api/env/<dc>/<env_id>/owner", methods=["POST"])
def api_update_owner(dc, env_id):
    if MOCK_MODE:
        return jsonify({"status": "error", "message": "Not available in mock mode"}), 400
    data = request.get_json()
    new_owner = data.get("owner", "").strip()
    if not new_owner:
        return jsonify({"status": "error", "message": "Owner name is required"}), 400
    env_base_name = f"rgs-{dc}-{env_id}"
    try:
        update_env_owner(dc, env_base_name, new_owner)
        return jsonify({"status": "ok", "owner": new_owner})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/history/pods/<dc>/<env_id>")
def api_pod_history(dc, env_id):
    environment = f"rgs-{dc}-{env_id}"
    service = request.args.get("service")
    hours = int(request.args.get("hours", "168"))
    data = get_pod_history(environment, service=service, hours=hours)
    return jsonify({"environment": environment, "services": data, "hours": hours})


@app.route("/api/history/nodes")
def api_node_history():
    node_name = request.args.get("node")
    hours = int(request.args.get("hours", "168"))
    if node_name:
        data = get_node_history(node_name=node_name, hours=hours)
        return jsonify({"node": data, "hours": hours})
    else:
        data = get_node_history(hours=hours)
        return jsonify({"nodes": data, "hours": hours})


@app.route("/api/history/sanity/<dc>/<env_id>")
def api_sanity_history(dc, env_id):
    environment = f"rgs-{dc}-{env_id}"
    limit = int(request.args.get("limit", "10"))
    data = get_sanity_history(environment, limit=limit)
    return jsonify({"environment": environment, "history": data})


@app.route("/api/history/recommendations/<dc>/<env_id>")
def api_recommendations(dc, env_id):
    environment = f"rgs-{dc}-{env_id}"
    hours = int(request.args.get("hours", "168"))
    recs = get_resource_recommendations(environment, hours=hours)
    return jsonify({"environment": environment, "recommendations": recs, "hours": hours})


@app.route("/api/history/cleanup", methods=["POST"])
def api_cleanup():
    days = int(request.args.get("days", "30"))
    cleanup_old_data(days=days)
    return jsonify({"status": "ok", "cleaned_older_than_days": days})


if __name__ == "__main__":
    print(f"Starting RGS OCP Dashboard (mock_mode={MOCK_MODE})")
    print(f"Dashboard: http://localhost:{FLASK_PORT}")
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG)
