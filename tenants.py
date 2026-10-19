"""Per-tenant storage usage breakdown.

Combines tenant names from /grid/accounts with Prometheus usage metrics.
Cached for 60 s to avoid hammering the StorageGRID admin API.
"""
import logging
import time

from client import StorageGridClient, make_client

logger = logging.getLogger(__name__)

_cache: dict = {"data": None, "fetched_at": 0.0}
_CACHE_TTL = 60   # seconds

# Cache the history result keyed by range string
_history_cache: dict = {}
_HISTORY_TTL = 60

# Range presets for tenant history (matches charts.py for consistency)
HISTORY_RANGES = {
    "1h":  (3600,    60),    # 1h at 1 min step
    "6h":  (21600,   300),   # 6h at 5 min step (default)
    "24h": (86400,   600),   # 24h at 10 min step
    "7d":  (604800,  3600),  # 7d at 1 h step
    "30d": (2592000, 21600), # 30d at 6 h step
}


def _client() -> StorageGridClient:
    if not hasattr(_client, "_inst"):
        _client._inst = make_client()
    return _client._inst


def _fetch_tenant_names(c: StorageGridClient) -> dict[str, str]:
    """Returns {tenant_id: display_name} from /grid/accounts."""
    names: dict[str, str] = {}
    resp = c.get_raw("/grid/accounts", params={"limit": 1000}, timeout=15)
    if resp.status_code != 200:
        logger.warning("Tenant accounts fetch failed: %s", resp.status_code)
        return names

    for t in resp.json().get("data", []):
        tid = t.get("id") or t.get("accountId")
        if not tid:
            continue
        names[tid] = t.get("name") or t.get("displayName") or tid
    return names


def _fetch_all() -> dict:
    c = _client()

    # Tenant names from the admin API
    names = _fetch_tenant_names(c)

    # NOTE: storagegrid_tenant_usage_* is grid-wide metadata replicated on
    # every admin node, so 'sum by(tenant_id)' double-counts (one value per
    # admin). Use 'max by(tenant_id)' to deduplicate.
    # Also, true per-site breakdown is not available — the metric's site_name
    # label is just the admin node's site, not where data physically lives
    # (distribution is determined by ILM rules and EC chunks).
    def _by_tenant(promql: str) -> dict[str, float]:
        result = c.query_metrics(promql)
        out: dict[str, float] = {}
        for item in result:
            tid = item["metric"].get("tenant_id", "")
            try:
                v = float(item["value"][1])
            except (TypeError, ValueError):
                continue
            if tid:
                out[tid] = v
        return out

    data_bytes   = _by_tenant("max by(tenant_id)(storagegrid_tenant_usage_data_bytes)")
    object_count = _by_tenant("max by(tenant_id)(storagegrid_tenant_usage_object_count)")
    quota_bytes  = _by_tenant("max by(tenant_id)(storagegrid_tenant_usage_quota_bytes)")

    # Build list, ordered by data bytes desc
    tenants = []
    all_ids = set(names) | set(data_bytes) | set(object_count) | set(quota_bytes)
    for tid in all_ids:
        used   = data_bytes.get(tid, 0.0)
        quota  = quota_bytes.get(tid, 0.0)
        usage_pct = round(used / quota * 100, 1) if quota > 0 else None
        tenants.append({
            "id":           tid,
            "name":         names.get(tid, tid),
            "data_bytes":   used,
            "object_count": int(object_count.get(tid, 0)),
            "quota_bytes":  quota,
            "usage_pct":    usage_pct,
        })
    tenants.sort(key=lambda t: -t["data_bytes"])

    return {"tenants": tenants, "count": len(tenants), "fetched_at": time.time()}


def get_tenant_history(range_key: str = "6h") -> dict:
    """Returns 6h (default) history of data_bytes per tenant.
       Format: {range_seconds, step_seconds, fetched_at, history: {tid: [[t,v],...]}}"""
    if range_key not in HISTORY_RANGES:
        range_key = "6h"
    import time as _t
    cached = _history_cache.get(range_key)
    if cached and (_t.time() - cached["fetched_at"]) < _HISTORY_TTL:
        return cached["data"]

    c = _client()
    range_secs, step = HISTORY_RANGES[range_key]
    end = int(_t.time())
    start = end - range_secs
    try:
        res = c.query_range(
            "max by(tenant_id)(storagegrid_tenant_usage_data_bytes)",
            start, end, step, timeout=25)
    except Exception as e:
        logger.error("Tenant history fetch failed: %s", e)
        return {"error": str(e), "history": {}}

    history: dict[str, list[list[float]]] = {}
    for item in res:
        tid = item.get("metric", {}).get("tenant_id", "")
        if not tid:
            continue
        pts = []
        for t, v in item.get("values", []):
            if v in ("NaN", "+Inf", "-Inf"):
                continue
            pts.append([float(t), float(v)])
        if pts:
            history[tid] = pts

    data = {
        "range_key":     range_key,
        "range_seconds": range_secs,
        "step_seconds":  step,
        "fetched_at":    end,
        "history":       history,
    }
    _history_cache[range_key] = {"data": data, "fetched_at": _t.time()}
    return data


def get_tenants() -> dict:
    now = time.time()
    if _cache["data"] is None or (now - _cache["fetched_at"]) > _CACHE_TTL:
        try:
            _cache["data"] = _fetch_all()
            _cache["fetched_at"] = now
        except Exception as e:
            logger.error("Tenant fetch failed: %s", e)
            if _cache["data"] is None:
                return {"tenants": [], "count": 0, "error": str(e)}
    return _cache["data"]
