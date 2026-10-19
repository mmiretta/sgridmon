"""Time-series charts for the left-side dashboard panel.

Pulls history (5 min to 7 days) from StorageGRID's
/grid/metric-query-range endpoint. Cached for 60 s per range.
"""
import logging
import time

from client import StorageGridClient, make_client

logger = logging.getLogger(__name__)

CACHE_TTL = 60          # seconds

# Per-range bundle: (range_seconds, step_seconds, rate_window_str)
# Step chosen to keep ~120-300 points per chart.
RANGE_PRESETS = {
    # Rate window must be ≥ 2× Prometheus scrape interval (~60-180s on StorageGRID).
    "5m":  (300,     30,   "2m"),
    "15m": (900,     30,   "3m"),
    "1h":  (3600,    60,   "5m"),
    "6h":  (21600,   120,  "10m"),
    "24h": (86400,   300,  "15m"),
    "7d":  (604800,  1800, "1h"),
}
DEFAULT_RANGE = "24h"

_cache: dict = {}   # keyed by range string


def _client() -> StorageGridClient:
    if not hasattr(_client, "_inst"):
        _client._inst = make_client()
    return _client._inst


def _range_query(c: StorageGridClient, promql: str, start: int, end: int, step: int):
    return c.query_range(promql, start, end, step)


def _series_single(res: list) -> list[list[float]]:
    """Flatten a single-series range_query result to [[t,v],...]."""
    if not res:
        return []
    values = res[0].get("values", [])
    return [[float(t), float(v) if v not in ("NaN", "+Inf", "-Inf") else 0.0] for t, v in values]


def _series_by_label(res: list, label: str) -> dict[str, list[list[float]]]:
    """Multiple series indexed by a label (e.g. site_name)."""
    out: dict[str, list[list[float]]] = {}
    for item in res:
        key = item.get("metric", {}).get(label, "")
        if not key:
            continue
        out[key] = [
            [float(t), float(v) if v not in ("NaN", "+Inf", "-Inf") else 0.0]
            for t, v in item.get("values", [])
        ]
    return out


def _fetch(range_key: str) -> dict:
    c = _client()
    range_secs, step, rate_win = RANGE_PRESETS[range_key]
    end = int(time.time())
    start = end - range_secs

    # Six queries in sequence (admin API doesn't support batch range queries)
    ingest_total = _series_single(_range_query(c,
        f"sum(rate(storagegrid_s3_data_transfers_bytes_ingested[{rate_win}]))",
        start, end, step))
    retrieve_total = _series_single(_range_query(c,
        f"sum(rate(storagegrid_s3_data_transfers_bytes_retrieved[{rate_win}]))",
        start, end, step))
    ingest_by_site = _series_by_label(_range_query(c,
        f"sum by(site_name)(rate(storagegrid_s3_data_transfers_bytes_ingested[{rate_win}]))",
        start, end, step), "site_name")
    retrieve_by_site = _series_by_label(_range_query(c,
        f"sum by(site_name)(rate(storagegrid_s3_data_transfers_bytes_retrieved[{rate_win}]))",
        start, end, step), "site_name")

    # ILM queue — these are gauges, no rate() needed
    ilm_total = _series_single(_range_query(c,
        "sum(storagegrid_ilm_awaiting_total_objects)", start, end, step))
    ilm_client = _series_single(_range_query(c,
        "sum(storagegrid_ilm_awaiting_client_objects)", start, end, step))
    ilm_background = _series_single(_range_query(c,
        "sum(storagegrid_ilm_awaiting_background_objects)", start, end, step))

    # Cassandra reaper — same range as other charts now.
    # avg by(keyspace) gives one line per keyspace (storagegrid / reaper_db / s3_batch).
    reaper_worst = _series_single(_range_query(c,
        "min(storagegrid_cassandra_repair_repaired_percent)",
        start, end, step))
    reaper_by_keyspace = _series_by_label(_range_query(c,
        "avg by(keyspace)(storagegrid_cassandra_repair_repaired_percent)",
        start, end, step), "keyspace")
    reaper_reachable = _series_single(_range_query(c,
        "sum(storagegrid_cassandra_repair_reaper_reachable)",
        start, end, step))

    return {
        "range_key":         range_key,
        "range_seconds":     range_secs,
        "step_seconds":      step,
        "fetched_at":        end,
        "ingest_total":      ingest_total,
        "retrieve_total":    retrieve_total,
        "ingest_by_site":    ingest_by_site,
        "retrieve_by_site":  retrieve_by_site,
        "ilm_total":         ilm_total,
        "ilm_client":        ilm_client,
        "ilm_background":    ilm_background,
        "reaper_worst":        reaper_worst,
        "reaper_by_keyspace":  reaper_by_keyspace,
        "reaper_reachable":    reaper_reachable,
    }


def get_charts(range_key: str = DEFAULT_RANGE) -> dict:
    if range_key not in RANGE_PRESETS:
        range_key = DEFAULT_RANGE
    entry = _cache.get(range_key, {"data": None, "fetched_at": 0.0})
    now = time.time()
    if entry["data"] is None or (now - entry["fetched_at"]) > CACHE_TTL:
        try:
            entry["data"] = _fetch(range_key)
            entry["fetched_at"] = now
            _cache[range_key] = entry
        except Exception as e:
            logger.error("Charts fetch failed (range=%s): %s", range_key, e)
            if entry["data"] is None:
                return {"error": str(e), "range_key": range_key}
    return entry["data"]
