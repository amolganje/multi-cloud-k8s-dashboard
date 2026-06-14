# Deploying OCP Dashboard on RHEL (Bare-Metal)

This guide deploys the dashboard directly on a Red Hat Enterprise Linux VM
using Python, Gunicorn, and systemd. No containers or OpenShift needed on the
host machine.

## Prerequisites

- RHEL 8 or 9 with root/sudo access
- Network access from the RHEL machine to all OCP cluster API endpoints (port 6443)
- OCP user credentials that work on all target clusters

## Quick Start (single command)

All credentials live in **one file**: `credentials.env`.
This file is gitignored and never committed.

```bash
cd /opt/rogers-dashboard/app
cp credentials.env.example credentials.env   # if not already present
vi credentials.env                            # fill in OCP and AWS creds
./start.sh
```

For production (systemd), see steps below — `start.sh` sources
`credentials.env` automatically.

---

## 1. Install Python 3.12

```bash
# RHEL 9 (AppStream)
sudo dnf install -y python3.12 python3.12-pip python3.12-devel

# RHEL 8 (AppStream)
sudo dnf install -y python39 python39-pip python39-devel
# (Python 3.9+ works fine; adjust venv path accordingly)
```

## 2. Create system user and directories

```bash
sudo useradd -r -s /sbin/nologin rogers-dashboard

sudo mkdir -p /opt/rogers-dashboard/app
sudo mkdir -p /opt/rogers-dashboard/data
sudo mkdir -p /opt/rogers-dashboard/venv
sudo mkdir -p /etc/rogers-dashboard

# The service runs as the rogers-dashboard user and must be able to write the
# SQLite history DB into the data dir (the only writable path under systemd).
sudo chown -R rogers-dashboard:rogers-dashboard /opt/rogers-dashboard/data
```

## 3. Copy application files

Copy the entire `rogers-dashboard-userpass` project to the server:

```bash
# From your local machine:
scp -r rogers-dashboard-userpass/* user@rhel-server:/opt/rogers-dashboard/app/

# Or if you're already on the server with the files:
cp -r /path/to/rogers-dashboard-userpass/* /opt/rogers-dashboard/app/
```

## 4. Create virtualenv and install dependencies

```bash
sudo python3.12 -m venv /opt/rogers-dashboard/venv

sudo /opt/rogers-dashboard/venv/bin/pip install --upgrade pip
sudo /opt/rogers-dashboard/venv/bin/pip install -r /opt/rogers-dashboard/app/requirements.txt
```

> **Offline install**: If the server has no internet, download wheels on a
> connected machine and copy them:
> ```bash
> # On connected machine:
> pip download -d ./wheels -r requirements.txt
> scp -r ./wheels user@rhel-server:/tmp/wheels
>
> # On RHEL server:
> sudo /opt/rogers-dashboard/venv/bin/pip install --no-index --find-links=/tmp/wheels -r /opt/rogers-dashboard/app/requirements.txt
> ```

## 5. Configure credentials

All credentials live in **one file**: `credentials.env`.

```bash
sudo vi /opt/rogers-dashboard/app/credentials.env
sudo chmod 600 /opt/rogers-dashboard/app/credentials.env
sudo chown rogers-dashboard:rogers-dashboard /opt/rogers-dashboard/app/credentials.env
```

Set these:
- `OCP_USERNAME` / `OCP_PASSWORD` — OCP login
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — for EKS
- `AWS_REGION` — default AWS region (per-cluster region overrides in `start.sh`)

Cluster definitions and quick links live in `start.sh`.

## 6. Install and start the systemd service

```bash
sudo cp /opt/rogers-dashboard/app/deploy/rogers-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rogers-dashboard
sudo systemctl start rogers-dashboard
```

Check status:

```bash
sudo systemctl status rogers-dashboard
sudo journalctl -u rogers-dashboard -f
```

## 7. Open firewall

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

## 8. Verify

Open in browser: `http://<rhel-server-ip>:8080`

Or from the server itself:

```bash
curl -s http://localhost:8080/ | head -20
curl -s http://localhost:8080/api/clusters | python3 -m json.tool | head -20
```

---

## Optional: Nginx reverse proxy with TLS

If you want HTTPS on port 443:

```bash
sudo dnf install -y nginx

sudo tee /etc/nginx/conf.d/rogers-dashboard.conf <<'EOF'
server {
    listen 443 ssl;
    server_name dashboard.example.com;

    ssl_certificate     /etc/pki/tls/certs/dashboard.crt;
    ssl_certificate_key /etc/pki/tls/private/dashboard.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo systemctl enable --now nginx
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

---

## Managing the service

| Action | Command |
|---|---|
| Start | `sudo systemctl start rogers-dashboard` |
| Stop | `sudo systemctl stop rogers-dashboard` |
| Restart | `sudo systemctl restart rogers-dashboard` |
| View logs | `sudo journalctl -u rogers-dashboard -f` |
| Check status | `sudo systemctl status rogers-dashboard` |

## Updating the application

```bash
# Copy new files
scp -r rogers-dashboard-userpass/* user@rhel-server:/opt/rogers-dashboard/app/

# Restart
sudo systemctl restart rogers-dashboard
```

## Updating credentials

```bash
sudo vi /opt/rogers-dashboard/app/credentials.env
sudo systemctl restart rogers-dashboard
```

## Updating cluster definitions / quick links

```bash
sudo vi /opt/rogers-dashboard/app/start.sh
sudo systemctl restart rogers-dashboard
```

---

## Troubleshooting

**"OAuth token exchange failed"** — Check that the OCP user exists on the
target clusters and the password is correct. Test manually (replace user:pass):

```bash
curl -sk -u <username>:<password> \
  "https://oauth-openshift.apps.prodocpcluster403.example.com/oauth/authorize?response_type=token&client_id=openshift-challenging-client" \
  -H "X-CSRF-Token: 1" \
  -D - -o /dev/null
```

You should see a `302` with a `Location` header containing `access_token=sha256~...`.

**"Connection refused" to API** — Ensure the RHEL machine can reach port 6443
on all cluster API servers. Test: `curl -sk https://api.prodocpcluster403.example.com:6443/version`

**Permission errors** — The OCP user (`OCP_USERNAME`) needs read access on each
cluster to the relevant namespaces (get/list on namespaces, pods, routes,
configmaps, nodes, and the env namespaces it monitors).
