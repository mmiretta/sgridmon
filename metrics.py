"""Periodic collection of StorageGRID Prometheus metrics (traffic, storage, latency).

Inter-site latency comes from grid-internal metrics, which are authoritative and
cover all sites regardless of whether sgridmon can reach each site directly.
"""

import asyncio
import logging
import math
from datetime import datetime, timezone

import config
from client import StorageGridClient, make_client

logger = logging.getLogger(__name__)


_traffic: dict = {"sites": {}, "last_updated": None}
_connectivity: dict = {"sites": {}, "pairs": {}, "last_updated": None}
_storage: dict = {"sites": {}, "last_updated": None}

_client: StorageGridClient | None = None


def get_traffic() -> dict:
    return _traffic


def get_connectivity() -> dict:
    return _connectivity

def get_storage() -> dict:
    return _storage


def _client_instance() -> StorageGridClient:
    global _client
    if _client is None:
        _client = make_client()
    return _client


def _safe_float(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _fetch_storage(c: StorageGridClient) -> dict:
    used_res  = c.query_metrics(
        "sum by(site_name, site_id)(storagegrid_storage_utilization_data_bytes)"
    )
    total_res = c.query_metrics(
        "sum by(site_name, site_id)(storagegrid_storage_utilization_total_space_bytes)"
    )
    usable_res = c.query_metrics(
        "sum by(site_name, site_id)(storagegrid_storage_utilization_usable_space_bytes)"
    )

    used   = {i["metric"]["site_id"]: _safe_float(i["value"][1]) for i in used_res   if "site_id" in i["metric"]}
    total  = {i["metric"]["site_id"]: _safe_float(i["value"][1]) for i in total_res  if "site_id" in i["metric"]}
    usable = {i["metric"]["site_id"]: _safe_float(i["value"][1]) for i in usable_res if "site_id" in i["metric"]}
    names  = {i["metric"]["site_id"]: i["metric"].get("site_name", "") for i in total_res if "site_id" in i["metric"]}

    sites: dict[str, dict] = {}
    for sid, name in names.items():
        u  = used.get(sid)   or 0.0
        us = usable.get(sid) or 0.0
        tot = total.get(sid) or 0.0
        # StorageGRID "Used %" formula: data / (data + usable). This matches the
        # value shown in the NetApp Grid Manager dashboard. Plain data/total is
        # lower because total_space includes metadata + system reserve overhead.
        denom = u + us
        pct = round(u / denom * 100, 1) if denom > 0 else 0.0
        sites[sid] = {
            "name":         name,
            "used_bytes":   u,
            "total_bytes":  tot,
            "usable_bytes": us,
            "used_pct":     pct,
            "status": (
                "critical" if pct >= 90
                else "warning" if pct >= 70
                else "ok"
            ),
        }

    return {"sites": sites, "last_updated": datetime.now(timezone.utc).isoformat()}


def _fetch_traffic(c: StorageGridClient) -> dict:
    """Per-site traffic split by network:
       - Grid network (eth0): inter-node + inter-site
       - Client network (eth2): S3 / API external traffic
       - Total: legacy storagegrid_network_*_bytes (all NICs combined, may
         double-count when there are bonded interfaces)
    """
    queries = {
        ("grid",   "in"):  'sum by(site_name, site_id)(rate(node_network_receive_bytes_total{device="eth0"}[5m]))',
        ("grid",   "out"): 'sum by(site_name, site_id)(rate(node_network_transmit_bytes_total{device="eth0"}[5m]))',
        ("client", "in"):  'sum by(site_name, site_id)(rate(node_network_receive_bytes_total{device="eth2"}[5m]))',
        ("client", "out"): 'sum by(site_name, site_id)(rate(node_network_transmit_bytes_total{device="eth2"}[5m]))',
        ("total",  "in"):  'sum by(site_name, site_id)(rate(storagegrid_network_received_bytes[5m]))',
        ("total",  "out"): 'sum by(site_name, site_id)(rate(storagegrid_network_transmitted_bytes[5m]))',
    }

    sites: dict[str, dict] = {}
    for (net, dir_), promql in queries.items():
        for item in c.query_metrics(promql):
            m = item["metric"]
            sid = m.get("site_id", "")
            if not sid:
                continue
            sites.setdefault(sid, {"name": m.get("site_name", ""), "site_id": sid})
            sites[sid][f"{net}_{dir_}_per_sec"] = _safe_float(item["value"][1]) or 0.0

    # Ensure all keys exist on every site (some networks may be 0 / missing)
    for v in sites.values():
        for net in ("grid", "client", "total"):
            for d in ("in", "out"):
                v.setdefault(f"{net}_{d}_per_sec", 0.0)
        # Backwards-compat for existing frontend
        v["bytes_in_per_sec"]  = v["total_in_per_sec"]
        v["bytes_out_per_sec"] = v["total_out_per_sec"]

    return {"sites": sites, "last_updated": datetime.now(timezone.utc).isoformat()}


def _fetch_connectivity(c: StorageGridClient, snapshot_getter) -> dict:
    """Per-site latency using remote-config round-trip time as measured by the grid itself."""
    latency_res = c.query_metrics(
        "sum by(site_name, site_id)"
        "(rate(storagegrid_go_remote_config_time_ms_sum[5m]))"
        " / "
        "sum by(site_name, site_id)"
        "(rate(storagegrid_go_remote_config_time_ms_count[5m]))"
    )

    lat_by_site: dict[str, float | None] = {}
    for item in latency_res:
        m = item["metric"]
        sid = m.get("site_id", "")
        if not sid:
            continue
        v = _safe_float(item["value"][1])
        if v is not None:
            existing = lat_by_site.get(sid)
            lat_by_site[sid] = max(existing, v) if existing is not None else v

    snapshot = snapshot_getter()
    sites_meta = {s["id"]: s["name"] for s in (snapshot.get("sites") or [])}

    def status(ms):
        if ms is None:   return "unreachable"
        if ms > 500:     return "critical"
        if ms > 100:     return "slow"
        return "ok"

    new_sites: dict[str, dict] = {}
    for sid, sname in sites_meta.items():
        ms = lat_by_site.get(sid)
        new_sites[sid] = {
            "name": sname,
            "latency_ms": round(ms, 1) if ms is not None else None,
            "status": status(ms),
            "source": "grid-internal",
            "last_checked": datetime.now(timezone.utc).isoformat(),
        }

    # Site-pair summary
    site_list = list(sites_meta.items())
    new_pairs: dict[str, dict] = {}
    for i, (sid1, sname1) in enumerate(site_list):
        for (sid2, sname2) in site_list[i + 1:]:
            key = "-".join(sorted([sid1, sid2]))
            la = new_sites.get(sid1, {}).get("latency_ms")
            lb = new_sites.get(sid2, {}).get("latency_ms")
            pair_ms = (
                round(max(la, lb), 1)
                if la is not None and lb is not None
                else (la or lb)
            )
            new_pairs[key] = {
                "latency_ms": pair_ms,
                "status": status(pair_ms),
                "site_a": sname1,
                "site_b": sname2,
                "lat_a": la,
                "lat_b": lb,
            }

    return {
        "sites": new_sites,
        "pairs": new_pairs,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


async def metrics_loop(snapshot_getter) -> None:
    global _traffic, _connectivity, _storage
    c = _client_instance()

    while True:
        try:
            _traffic = await asyncio.to_thread(_fetch_traffic, c)
            logger.info(
                "Traffic: %s",
                "  ".join(
                    f"{v['name']} grid_out={v['grid_out_per_sec']/1e6:.0f}MB/s"
                    f" client_out={v['client_out_per_sec']/1e6:.0f}MB/s"
                    for v in _traffic["sites"].values()
                ),
            )
        except Exception as e:
            logger.error("Traffic metrics error: %s", e)

        try:
            _storage = await asyncio.to_thread(_fetch_storage, c)
            logger.info(
                "Storage: %s",
                "  ".join(
                    f"{v['name']}={v['used_pct']}%"
                    for v in _storage["sites"].values()
                ),
            )
        except Exception as e:
            logger.error("Storage metrics error: %s", e)

        try:
            _connectivity = await asyncio.to_thread(
                _fetch_connectivity, c, snapshot_getter
            )
            logger.info(
                "Connectivity: %s",
                "  ".join(
                    f"{v['name']}={v['latency_ms']}ms"
                    for v in _connectivity["sites"].values()
                ),
            )
        except Exception as e:
            logger.error("Connectivity metrics error: %s", e)

        await asyncio.sleep(config.METRICS_INTERVAL)
