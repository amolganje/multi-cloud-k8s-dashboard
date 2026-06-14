"""
AWS client for EKS authentication.

EKS uses a special token format: a base64-encoded presigned URL to STS's
GetCallerIdentity endpoint, with the EKS cluster name in the
x-k8s-aws-id header. EKS verifies the signature with AWS IAM and
accepts it as a bearer token.

No aws-iam-authenticator binary required - the signing is done in Python via boto3.
"""
import base64
import logging
import threading
import time

import boto3
from botocore.config import Config
from botocore.signers import RequestSigner

from config import (
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    AWS_TOKEN_TTL,
)

log = logging.getLogger(__name__)

# Bound every AWS API call so unreachable endpoints (e.g. no egress to AWS)
# fail fast instead of hanging worker startup. Worst case per call is roughly
# (connect_timeout + read_timeout) * max_attempts.
_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=10,
    retries={"max_attempts": 2, "mode": "standard"},
)

_eks_token_cache = {}
_eks_describe_cache = {}
_cache_lock = threading.Lock()


def _get_boto_session(region=None):
    """Build a boto3 session from configured static credentials."""
    return boto3.session.Session(
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=region or AWS_REGION,
    )


def get_eks_token(eks_cluster_name, region=None):
    """Return a bearer token for an EKS cluster (cached ~AWS_TOKEN_TTL seconds).

    Generates a presigned STS GetCallerIdentity URL with the EKS cluster
    name in a custom header, then base64-encodes it as a k8s-aws-v1 token.
    """
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        raise RuntimeError(
            "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not configured; "
            "cannot authenticate to EKS cluster '%s'" % eks_cluster_name
        )

    region = region or AWS_REGION
    cache_key = f"{region}/{eks_cluster_name}"

    with _cache_lock:
        cached = _eks_token_cache.get(cache_key)
        if cached and (time.time() - cached["ts"]) < AWS_TOKEN_TTL:
            return cached["token"]

    session = _get_boto_session(region)
    sts_client = session.client("sts", region_name=region, config=_BOTO_CONFIG)
    service_id = sts_client.meta.service_model.service_id

    signer = RequestSigner(
        service_id,
        region,
        "sts",
        "v4",
        session.get_credentials(),
        session.events,
    )

    params = {
        "method": "GET",
        "url": f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
        "body": {},
        "headers": {"x-k8s-aws-id": eks_cluster_name},
        "context": {},
    }

    signed_url = signer.generate_presigned_url(
        params,
        region_name=region,
        expires_in=60,
        operation_name="",
    )

    token = "k8s-aws-v1." + base64.urlsafe_b64encode(
        signed_url.encode("utf-8")
    ).decode("utf-8").rstrip("=")

    with _cache_lock:
        _eks_token_cache[cache_key] = {"token": token, "ts": time.time()}

    log.info("Generated EKS token for cluster '%s' in region %s", eks_cluster_name, region)
    return token


def list_eks_clusters(region=None):
    """List all EKS cluster names visible to the configured AWS credentials in a region."""
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        return []
    region = region or AWS_REGION
    session = _get_boto_session(region)
    eks = session.client("eks", region_name=region, config=_BOTO_CONFIG)
    names = []
    paginator = eks.get_paginator("list_clusters")
    for page in paginator.paginate():
        names.extend(page.get("clusters", []))
    return names


def discover_eks_clusters(region=None):
    """Discover all EKS clusters in the AWS account/region and build cluster-config entries.

    Returns a dict shaped like CLUSTERS_CONFIG so it can be merged in directly.
    The cluster_id used as the key is the EKS cluster name itself.
    """
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        return {}
    region = region or AWS_REGION
    try:
        names = list_eks_clusters(region)
    except Exception as e:
        log.warning("EKS auto-discovery failed in region %s: %s", region, e)
        return {}

    result = {}
    for name in names:
        result[name] = {
            "provider": "aws",
            "full_name": name,
            "eks_cluster_name": name,
            "env_name": name,
            "region": region,
        }
    if result:
        log.info("Auto-discovered %d EKS cluster(s) in %s: %s", len(result), region, list(result.keys()))
    return result


def describe_eks_cluster(eks_cluster_name, region=None):
    """Return EKS cluster endpoint URL and CA data (cached).

    Used to populate the K8s client configuration. Cached indefinitely
    since these don't change at runtime.
    """
    region = region or AWS_REGION
    cache_key = f"{region}/{eks_cluster_name}"

    with _cache_lock:
        if cache_key in _eks_describe_cache:
            return _eks_describe_cache[cache_key]

    session = _get_boto_session(region)
    eks = session.client("eks", region_name=region, config=_BOTO_CONFIG)
    resp = eks.describe_cluster(name=eks_cluster_name)
    info = {
        "endpoint": resp["cluster"]["endpoint"],
        "ca_data": resp["cluster"]["certificateAuthority"]["data"],
        "status": resp["cluster"]["status"],
        "version": resp["cluster"].get("version", ""),
    }

    with _cache_lock:
        _eks_describe_cache[cache_key] = info

    log.info("Described EKS cluster '%s': endpoint=%s status=%s", eks_cluster_name, info["endpoint"], info["status"])
    return info


def invalidate_eks_token(eks_cluster_name, region=None):
    """Drop cached token for a cluster (call on 401)."""
    region = region or AWS_REGION
    cache_key = f"{region}/{eks_cluster_name}"
    with _cache_lock:
        _eks_token_cache.pop(cache_key, None)
