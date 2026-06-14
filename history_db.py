"""
History database for tracking pod/node CPU & memory usage over time.
Uses SQLite for simplicity - no extra dependencies required.
"""
import sqlite3
import os
from datetime import datetime, timedelta

DB_PATH = os.environ.get("HISTORY_DB_PATH", "history.db")
_db_available = True


def get_db():
    """Get a database connection."""
    if not _db_available:
        return None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """Initialize the database schema. Non-fatal if DB path is not writable."""
    global _db_available
    db_dir = os.path.dirname(DB_PATH)
    if db_dir and not os.path.exists(db_dir):
        try:
            os.makedirs(db_dir, exist_ok=True)
        except OSError as e:
            print(f"WARNING: Cannot create DB directory {db_dir}: {e}. History disabled.")
            _db_available = False
            return
    try:
        conn = get_db()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS pod_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                environment TEXT NOT NULL,
                namespace TEXT NOT NULL,
                pod_name TEXT NOT NULL,
                service TEXT NOT NULL,
                cpu_usage_pct REAL NOT NULL,
                mem_usage_pct REAL NOT NULL,
                cpu_request TEXT,
                cpu_limit TEXT,
                mem_request TEXT,
                mem_limit TEXT,
                status TEXT
            );

            CREATE TABLE IF NOT EXISTS node_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                node_name TEXT NOT NULL,
                role TEXT NOT NULL,
                cpu_usage_pct REAL NOT NULL,
                mem_usage_pct REAL NOT NULL,
                cpu_capacity TEXT,
                mem_capacity TEXT,
                pods_count INTEGER,
                status TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_pod_snap_env_ts
                ON pod_snapshots(environment, timestamp);
            CREATE INDEX IF NOT EXISTS idx_pod_snap_pod_ts
                ON pod_snapshots(pod_name, timestamp);
            CREATE INDEX IF NOT EXISTS idx_pod_snap_svc_ts
                ON pod_snapshots(service, environment, timestamp);
            CREATE INDEX IF NOT EXISTS idx_node_snap_ts
                ON node_snapshots(node_name, timestamp);

            CREATE TABLE IF NOT EXISTS sanity_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                environment TEXT NOT NULL,
                passrate REAL NOT NULL,
                total_tests INTEGER,
                passed_tests INTEGER,
                failed_tests INTEGER,
                jenkins_build_url TEXT,
                jenkins_build_number TEXT,
                sanity_jar_version TEXT,
                suite TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_sanity_snap_env_ts
                ON sanity_snapshots(environment, timestamp);
        """)
        conn.commit()
        conn.close()
        print(f"History DB initialized at {DB_PATH}")
    except Exception as e:
        print(f"WARNING: Failed to initialize history DB at {DB_PATH}: {e}. History disabled.")
        _db_available = False


def save_pod_snapshot(env_data):
    """Save a snapshot of all pod metrics for an environment."""
    conn = get_db()
    if not conn:
        return
    ts = datetime.utcnow().isoformat() + "Z"
    environment = env_data["environment"]

    rows = []
    for ns_key in ["runtime", "authoring", "backingservices"]:
        ns = env_data["namespaces"][ns_key]
        for pod in ns["pods"]:
            rows.append((
                ts, environment, ns["name"], pod["name"], pod["service"],
                pod["cpu_usage_pct"], pod["mem_usage_pct"],
                pod.get("cpu_request", ""), pod.get("cpu_limit", ""),
                pod.get("mem_request", ""), pod.get("mem_limit", ""),
                pod["status"],
            ))

    conn.executemany("""
        INSERT INTO pod_snapshots
            (timestamp, environment, namespace, pod_name, service,
             cpu_usage_pct, mem_usage_pct, cpu_request, cpu_limit,
             mem_request, mem_limit, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()
    conn.close()


def save_node_snapshot(nodes):
    """Save a snapshot of all node metrics."""
    conn = get_db()
    if not conn:
        return
    ts = datetime.utcnow().isoformat() + "Z"

    rows = []
    for node in nodes:
        rows.append((
            ts, node["name"], node["role"],
            node["cpu_usage_pct"], node["mem_usage_pct"],
            node.get("cpu_capacity", ""), node.get("mem_capacity", ""),
            node.get("pods_count", 0), node["status"],
        ))

    conn.executemany("""
        INSERT INTO node_snapshots
            (timestamp, node_name, role, cpu_usage_pct, mem_usage_pct,
             cpu_capacity, mem_capacity, pods_count, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()
    conn.close()


def get_pod_history(environment, service=None, hours=24):
    """
    Get pod CPU/memory history for an environment.
    If service is specified, returns per-pod data.
    Otherwise, returns aggregated averages per service.
    """
    conn = get_db()
    if not conn:
        return {}
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat() + "Z"

    if service:
        rows = conn.execute("""
            SELECT timestamp, pod_name, cpu_usage_pct, mem_usage_pct,
                   cpu_request, cpu_limit, mem_request, mem_limit, status
            FROM pod_snapshots
            WHERE environment = ? AND service = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        """, (environment, service, cutoff)).fetchall()

        result = {}
        for r in rows:
            pod = r["pod_name"]
            if pod not in result:
                result[pod] = {
                    "pod_name": pod,
                    "cpu_request": r["cpu_request"],
                    "cpu_limit": r["cpu_limit"],
                    "mem_request": r["mem_request"],
                    "mem_limit": r["mem_limit"],
                    "history": [],
                }
            result[pod]["history"].append({
                "ts": r["timestamp"],
                "cpu": r["cpu_usage_pct"],
                "mem": r["mem_usage_pct"],
                "status": r["status"],
            })
        conn.close()
        return list(result.values())
    else:
        # Aggregate: avg CPU/mem per service per timestamp
        rows = conn.execute("""
            SELECT timestamp, service,
                   AVG(cpu_usage_pct) as avg_cpu,
                   AVG(mem_usage_pct) as avg_mem,
                   MAX(cpu_request) as cpu_request,
                   MAX(cpu_limit) as cpu_limit,
                   MAX(mem_request) as mem_request,
                   MAX(mem_limit) as mem_limit,
                   COUNT(*) as pod_count
            FROM pod_snapshots
            WHERE environment = ? AND timestamp >= ?
            GROUP BY timestamp, service
            ORDER BY timestamp ASC
        """, (environment, cutoff)).fetchall()

        result = {}
        for r in rows:
            svc = r["service"]
            if svc not in result:
                result[svc] = {
                    "service": svc,
                    "cpu_request": r["cpu_request"],
                    "cpu_limit": r["cpu_limit"],
                    "mem_request": r["mem_request"],
                    "mem_limit": r["mem_limit"],
                    "pod_count": r["pod_count"],
                    "history": [],
                }
            result[svc]["history"].append({
                "ts": r["timestamp"],
                "avg_cpu": round(r["avg_cpu"], 1),
                "avg_mem": round(r["avg_mem"], 1),
            })
        conn.close()
        return list(result.values())


def get_node_history(node_name=None, hours=24):
    """Get node CPU/memory history."""
    conn = get_db()
    if not conn:
        return {} if node_name else []
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat() + "Z"

    if node_name:
        rows = conn.execute("""
            SELECT timestamp, cpu_usage_pct, mem_usage_pct, pods_count, status
            FROM node_snapshots
            WHERE node_name = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        """, (node_name, cutoff)).fetchall()

        history = [{
            "ts": r["timestamp"],
            "cpu": r["cpu_usage_pct"],
            "mem": r["mem_usage_pct"],
            "pods": r["pods_count"],
            "status": r["status"],
        } for r in rows]
        conn.close()
        return {"node_name": node_name, "history": history}
    else:
        rows = conn.execute("""
            SELECT timestamp, node_name, role,
                   cpu_usage_pct, mem_usage_pct, pods_count,
                   cpu_capacity, mem_capacity
            FROM node_snapshots
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        """, (cutoff,)).fetchall()

        result = {}
        for r in rows:
            name = r["node_name"]
            if name not in result:
                result[name] = {
                    "node_name": name,
                    "role": r["role"],
                    "cpu_capacity": r["cpu_capacity"],
                    "mem_capacity": r["mem_capacity"],
                    "history": [],
                }
            result[name]["history"].append({
                "ts": r["timestamp"],
                "cpu": r["cpu_usage_pct"],
                "mem": r["mem_usage_pct"],
                "pods": r["pods_count"],
            })
        conn.close()
        return list(result.values())


def get_resource_recommendations(environment, hours=24):
    """
    Analyze historical data to recommend resource adjustments.
    Identifies pods that consistently use much less than their requests.
    """
    conn = get_db()
    if not conn:
        return []
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat() + "Z"

    rows = conn.execute("""
        SELECT service,
               AVG(cpu_usage_pct) as avg_cpu,
               MAX(cpu_usage_pct) as max_cpu,
               AVG(mem_usage_pct) as avg_mem,
               MAX(mem_usage_pct) as max_mem,
               MAX(cpu_request) as cpu_request,
               MAX(cpu_limit) as cpu_limit,
               MAX(mem_request) as mem_request,
               MAX(mem_limit) as mem_limit,
               COUNT(DISTINCT pod_name) as replica_count,
               COUNT(DISTINCT timestamp) as sample_count
        FROM pod_snapshots
        WHERE environment = ? AND timestamp >= ?
        GROUP BY service
        HAVING sample_count >= 2
    """, (environment, cutoff)).fetchall()

    recommendations = []
    for r in rows:
        avg_cpu = round(r["avg_cpu"], 1)
        max_cpu = round(r["max_cpu"], 1)
        avg_mem = round(r["avg_mem"], 1)
        max_mem = round(r["max_mem"], 1)

        rec = {
            "service": r["service"],
            "avg_cpu_pct": avg_cpu,
            "max_cpu_pct": max_cpu,
            "avg_mem_pct": avg_mem,
            "max_mem_pct": max_mem,
            "cpu_request": r["cpu_request"],
            "mem_request": r["mem_request"],
            "replica_count": r["replica_count"],
            "samples": r["sample_count"],
            "cpu_action": "ok",
            "mem_action": "ok",
        }

        # If max usage is consistently below 30%, suggest reducing
        if max_cpu < 30:
            rec["cpu_action"] = "reduce"
        elif avg_cpu > 80:
            rec["cpu_action"] = "increase"

        if max_mem < 30:
            rec["mem_action"] = "reduce"
        elif avg_mem > 80:
            rec["mem_action"] = "increase"

        recommendations.append(rec)

    conn.close()
    return recommendations


def save_sanity_snapshot(env_data):
    """Save a sanity test result snapshot."""
    conn = get_db()
    if not conn:
        return
    ts = datetime.utcnow().isoformat() + "Z"
    environment = env_data["environment"]
    sanity = env_data.get("sanity", {})
    passrate = sanity.get("sanity_passrate_value", 0)

    # Avoid duplicates: skip if we already saved this exact build number
    existing = conn.execute(
        "SELECT id FROM sanity_snapshots WHERE environment = ? AND jenkins_build_number = ?",
        (environment, sanity.get("jenkins_build_number", ""))
    ).fetchone()

    if not existing:
        conn.execute("""
            INSERT INTO sanity_snapshots
                (timestamp, environment, passrate, total_tests, passed_tests,
                 failed_tests, jenkins_build_url, jenkins_build_number,
                 sanity_jar_version, suite)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ts, environment, passrate,
            int(sanity.get("total_tests", 0)),
            int(sanity.get("passed_tests", 0)),
            int(sanity.get("failed_tests", 0)),
            sanity.get("jenkins_build_url", ""),
            sanity.get("jenkins_build_number", ""),
            sanity.get("sanity_jar_version", ""),
            sanity.get("suite", ""),
        ))
        conn.commit()
    conn.close()


def get_sanity_history(environment, limit=10):
    """Get last N sanity build results for an environment."""
    conn = get_db()
    if not conn:
        return []
    rows = conn.execute("""
        SELECT timestamp, passrate, total_tests, passed_tests, failed_tests,
               jenkins_build_url, jenkins_build_number, sanity_jar_version, suite
        FROM sanity_snapshots
        WHERE environment = ?
        ORDER BY timestamp DESC
        LIMIT ?
    """, (environment, limit)).fetchall()
    conn.close()
    return [{
        "timestamp": r["timestamp"],
        "passrate": r["passrate"],
        "total_tests": r["total_tests"],
        "passed_tests": r["passed_tests"],
        "failed_tests": r["failed_tests"],
        "jenkins_build_url": r["jenkins_build_url"],
        "jenkins_build_number": r["jenkins_build_number"],
        "sanity_jar_version": r["sanity_jar_version"],
        "suite": r["suite"],
    } for r in rows]


def cleanup_old_data(days=30):
    """Remove snapshots older than given days."""
    conn = get_db()
    if not conn:
        return
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat() + "Z"
    conn.execute("DELETE FROM pod_snapshots WHERE timestamp < ?", (cutoff,))
    conn.execute("DELETE FROM node_snapshots WHERE timestamp < ?", (cutoff,))
    conn.execute("DELETE FROM sanity_snapshots WHERE timestamp < ?", (cutoff,))
    conn.commit()
    conn.close()
