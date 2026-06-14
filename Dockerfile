# =============================================================================
# Multi-Cloud Dashboard (OCP + AWS EKS) — container image
#
# Connects OUT to OCP clusters (OAuth via OCP_USERNAME/OCP_PASSWORD) and to
# AWS EKS clusters (STS via AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). It does
# NOT need any in-cluster RBAC on the cluster it runs on.
#
# Build (fully offline — no internet needed):
#   docker build -t <registry>/rogers-dashboard:latest .
#   docker push  <registry>/rogers-dashboard:latest
#
# Build-only inputs (packages/ wheels, vendor/awscliv2.zip) are consumed in
# throwaway stages and are NEVER baked into the final image — it contains only
# the installed dependencies, the AWS CLI, and the application code.
#
# OpenShift note: the restricted SCC runs this with a random non-root UID that
# belongs to GID 0. The image is built so that UID can read the app and write
# the SQLite history DB (see chgrp/chmod below).
# =============================================================================

# --- Stage 1: install AWS CLI v2 from the bundled offline zip ----------------
# Lets you exec into the pod and test AWS connectivity, e.g.:
#   oc exec -it <pod> -- aws sts get-caller-identity
#   oc exec -it <pod> -- aws eks list-clusters --region <region>
# (extracted with Python since the slim image has no unzip; the 72 MB zip stays
#  in this throwaway stage so it never bloats the final image.)
FROM python:3.12-slim AS awscli
COPY vendor/awscliv2.zip /tmp/awscliv2.zip
RUN python -m zipfile -e /tmp/awscliv2.zip /tmp/ \
    && chmod -R +x /tmp/aws \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

# --- Stage 2: install Python deps offline into an isolated prefix ------------
# Every wheel (incl. boto3, botocore, s3transfer, jmespath) is bundled in
# packages/ for cp312/linux. Installing into /install (a throwaway stage) means
# the wheels are NOT carried into the final image — only the installed packages.
FROM python:3.12-slim AS deps
COPY requirements.txt .
COPY packages/ /tmp/packages/
RUN pip install --no-index --find-links=/tmp/packages/ \
        --prefix=/install --root-user-action=ignore -r requirements.txt

# --- Stage 3: final application image ----------------------------------------
FROM python:3.12-slim

# Runtime defaults — override at deploy time via ConfigMap / Secret.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MOCK_MODE=false \
    FLASK_DEBUG=false \
    FLASK_PORT=8080 \
    HISTORY_DB_PATH=/data/history.db

WORKDIR /app

# Installed Python deps (no wheels) from the deps stage.
COPY --from=deps /install /usr/local

# AWS CLI v2 from the awscli stage. Honours the same HTTP_PROXY / HTTPS_PROXY /
# NO_PROXY env vars as the app.
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

# Application code — only what the app imports at runtime (no venv, packages/,
# vendor/, k8s/, deploy/, db artifacts, docs or start.sh).
COPY app.py config.py history_db.py mock_data.py k8s_client.py aws_client.py ./
COPY static/ ./static/
COPY templates/ ./templates/

# --- OpenShift arbitrary-UID compatibility -----------------------------------
# Make /app and the writable /data dir group-owned by GID 0 and group-writable.
RUN mkdir -p /data \
    && chgrp -R 0 /app /data \
    && chmod -R g=u /app /data

EXPOSE 8080
USER 1001

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
