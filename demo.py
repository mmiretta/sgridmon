"""Demo mode: a fully synthetic StorageGRID.

Enabled with SGRIDMON_DEMO=1. ``DemoClient`` implements the same surface as
``client.StorageGridClient`` (REST paths + PromQL instant/range queries), so the
rest of sgridmon runs unchanged on top of it. Every name, serial number and
address below is invented; IPs come from the RFC 5737 documentation ranges.

The fake grid: 3 sites (DC1, DC2, DC3), 30 nodes, a handful of active alerts,
one disconnected node, varied fill levels, ~14 tenants with buckets.
"""
from __future__ import annotations

import math
import random
import time
import uuid
import zlib
from datetime import datetime, timedelta, timezone

_NS = uuid.UUID("6f1c9a52-3d4e-4b8a-9c71-0d2e5f6a7b80")


def _uid(name: str) -> str:
    return str(uuid.uuid5(_NS, name))


def _noise(key: str, t: float, amp: float) -> float:
    """Deterministic pseudo-noise in [-amp, amp] for (key, t)."""
    h = zlib.crc32(f"{key}|{int(t)}".encode()) & 0xFFFFFFFF
    return (h / 0xFFFFFFFF * 2 - 1) * amp


def _smooth(key: str, t: float, period: float, amp: float) -> float:
    """Smoothly interpolated deterministic noise (changes over ``period`` seconds)."""
    k, frac = divmod(t / period, 1.0)
    a, b = _noise(key, k, amp), _noise(key, k + 1, amp)
    w = (1 - math.cos(math.pi * frac)) / 2
    return a * (1 - w) + b * w


TB = 1024 ** 4
GB = 1024 ** 3
MB = 1024 ** 2

# ── Topology ──────────────────────────────────────────────────────────────────
# (site name, gateways, storage nodes, base fill %, inter-site latency ms, IP prefix)
_SITE_SPECS = [
    ("DC1", 2, 8, 61.0, 4.2, "198.51.100."),
    ("DC2", 1, 7, 76.0, 11.8, "203.0.113."),
    ("DC3", 1, 8, 87.0, 27.5, "192.0.2."),
]

SITES: list[dict] = []
NODES: list[dict] = []
_IPS: dict[str, str] = {}

_rng = random.Random(20240501)

for _si, (_sname, _ngw, _nsn, _fill, _lat, _ipfx) in enumerate(_SITE_SPECS):
    _sid = _uid("site:" + _sname)
    SITES.append({"id": _sid, "name": _sname, "fill": _fill, "latency": _lat})
    _prefix = _sname.lower()
    _members = [("adm01", "adminNode")]
    _members += [(f"gw{i:02d}", "apiGatewayNode") for i in range(1, _ngw + 1)]
    _members += [(f"sn{i:02d}", "storageNode") for i in range(1, _nsn + 1)]
    for _hi, (_suffix, _ntype) in enumerate(_members):
        _name = f"{_prefix}-{_suffix}"
        _node = {
            "id": _uid("node:" + _name),
            "name": _name,
            "type": _ntype,
            "siteId": _sid,
            "siteName": _sname,
            "isPrimaryAdmin": _si == 0 and _ntype == "adminNode",
            "state": "connected",
        }
        if _ntype == "storageNode":
            _node["fill"] = max(20.0, min(97.0, _fill + _rng.uniform(-7, 7)))
            _node["capacity"] = _rng.choice([360, 480, 720]) * TB
            _node["model"] = _rng.choice(["SG6060", "SG6160", "SG5760"])
            _node["shelves"] = _rng.choice([0, 0, 1, 2]) if _node["model"].startswith("SG6") else 0
        elif _ntype == "adminNode":
            _node["model"] = "SG100"
        else:
            _node["model"] = "SG1100"
        _node["board_serial"] = f"{_rng.randint(10**11, 10**12 - 1)}"
        _node["chassis_serial"] = f"{_rng.randint(10**9, 10**10 - 1)}"
        _node["bios"] = _rng.choice(["3.9.1", "3.9.2", "4.0.0"])
        NODES.append(_node)
        _IPS[_name] = f"{_ipfx}{10 + _hi}"

_BY_NAME = {n["name"]: n for n in NODES}

# Make the DC3 picture a bit more interesting: two nodes above 90 %, one offline.
_BY_NAME["dc3-sn02"]["fill"] = 93.4
_BY_NAME["dc3-sn07"]["fill"] = 91.2
_BY_NAME["dc3-sn05"]["state"] = "disconnected"
for _n in NODES:   # nobody else above the "Low object data storage" threshold
    if _n.get("fill", 0) > 88.5 and _n["name"] not in ("dc3-sn02", "dc3-sn07"):
        _n["fill"] = 88.5 - _rng.uniform(0, 4)

# ── Alerts ────────────────────────────────────────────────────────────────────
_NOW0 = datetime.now(timezone.utc)

_ALERT_SPECS = [
    ("dc3-sn05", "Unable to communicate with node", "critical", "",
     "The node is not reachable from the primary Admin Node.",
     "Check power, network cabling and the node's services, then use Grid Manager to verify connectivity.",
     6),
    ("dc3-sn02", "Low object data storage", "major", "ldr",
     "Available space for object data on this Storage Node is low.",
     "Add storage capacity (expansion) or adjust ILM rules before the node becomes read-only.",
     52),
    ("dc3-sn07", "Low object data storage", "major", "ldr",
     "Available space for object data on this Storage Node is low.",
     "Add storage capacity (expansion) or adjust ILM rules before the node becomes read-only.",
     30),
    ("dc1-sn04", "Appliance fan fault detected", "minor", "",
     "A fan in the appliance has failed or is not detected.",
     "Replace the failed fan module.",
     20),
    ("dc1-gw02", "Expiration of server certificate for Storage API Endpoints", "minor", "nginx-gw",
     "The S3 endpoint server certificate expires in 21 days.",
     "Upload a renewed certificate in Grid Manager (Configuration > Security > Certificates).",
     70),
    ("dc2-adm01", "High Java heap use", "minor", "dmv",
     "Java heap usage on this node is above the warning threshold.",
     "Monitor the trend; contact support if it keeps increasing.",
     3),
    ("dc2-sn05", "Node network reception frame errors", "notice", "",
     "A small number of frame errors was detected on the grid network interface.",
     "Check cabling and switch port counters.",
     11),
    ("dc2-sn06", "Node network reception frame errors", "notice", "",
     "A small number of frame errors was detected on the grid network interface.",
     "Check cabling and switch port counters.",
     11),
]

_SEV_RANK = {"critical": 4, "major": 3, "minor": 2, "warning": 1, "notice": 0, "normal": 0}


def _alerts() -> list[dict]:
    out = []
    for i, (node, name, sev, svc, desc, action, hours_ago) in enumerate(_ALERT_SPECS):
        out.append({
            "id": _uid(f"alert:{i}"),
            "name": name,
            "status": "active",
            "labels": {"node_id": _BY_NAME[node]["id"], "severity": sev, "service": svc},
            "annotations": {"description": desc, "recommendedActions": action},
            "startsAt": (_NOW0 - timedelta(hours=hours_ago)).isoformat().replace("+00:00", "Z"),
            "silenced": False,
        })
    return out


def _node_severity(node: dict) -> str:
    worst = "normal"
    for (n, _name, sev, *_rest) in _ALERT_SPECS:
        if n == node["name"] and _SEV_RANK[sev] > _SEV_RANK[worst]:
            worst = sev
    return worst


# ── Tenants & buckets ─────────────────────────────────────────────────────────
_TENANT_NAMES = [
    "data-lake", "backup-archive", "media-assets", "ml-training", "log-retention",
    "video-archive", "analytics-prod", "web-static", "iot-telemetry", "finance-reports",
    "ci-artifacts", "mail-journal", "docs-portal", "dev-sandbox",
]
_BUCKET_SUFFIXES = ["raw", "curated", "exports", "daily", "weekly", "originals",
                    "thumbs", "models", "checkpoints", "staging", "cold", "hot"]

TENANTS: list[dict] = []
_trng = random.Random(77)
for _i, _tname in enumerate(_TENANT_NAMES):
    _size = 1.4 * 1024 * TB / (1.55 ** _i) * _trng.uniform(0.8, 1.2)
    _quota = 0.0
    if _i % 3 != 1:
        _quota = _size / _trng.uniform(0.35, 0.95)
    _nb = _trng.randint(2, 6)
    _weights = [_trng.random() ** 2 + 0.02 for _ in range(_nb)]
    _ws = sum(_weights)
    _buckets = []
    for _b, _sfx in enumerate(_trng.sample(_BUCKET_SUFFIXES, _nb)):
        _bytes = _size * _weights[_b] / _ws
        _buckets.append({
            "name": f"{_tname}-{_sfx}",
            "bytes": _bytes,
            "avg_obj": _trng.choice([64 * 1024, 512 * 1024, 4 * MB, 32 * MB]),
            "growth": _trng.choice([0.0, 0.0, 0.002, 0.006, 0.015, -0.003]),  # per day
        })
    TENANTS.append({
        "id": "".join(str(_trng.randint(0, 9)) for _ in range(20)),
        "name": _tname,
        "bytes": _size,
        "quota": _quota,
        "growth": sum(b["bytes"] * b["growth"] for b in _buckets) / _size,
        "buckets": _buckets,
    })
_TENANT_BY_ID = {t["id"]: t for t in TENANTS}


def _bucket_bytes(b: dict, t: float) -> float:
    days = (t - time.time()) / 86400.0
    return max(0.0, b["bytes"] * (1 + b["growth"] * days))


def _tenant_bytes(tn: dict, t: float) -> float:
    return sum(_bucket_bytes(b, t) for b in tn["buckets"])


# ── Time-varying series ───────────────────────────────────────────────────────
def _diurnal(t: float, phase_h: float = 0.0) -> float:
    """0..1 daily load curve peaking in the afternoon."""
    return 0.5 + 0.5 * math.sin(2 * math.pi * ((t / 3600.0 + phase_h - 9) % 24) / 24)


def _site_ingest(site: dict, t: float) -> float:
    base = {"DC1": 950 * MB, "DC2": 620 * MB, "DC3": 410 * MB}[site["name"]]
    return base * (0.25 + 0.9 * _diurnal(t, 0.5)) * (1 + _smooth("ing" + site["name"], t, 1800, 0.10) + _noise("ing" + site["name"], t / 300, 0.03))


def _site_retrieve(site: dict, t: float) -> float:
    base = {"DC1": 1400 * MB, "DC2": 780 * MB, "DC3": 300 * MB}[site["name"]]
    return base * (0.2 + 0.8 * _diurnal(t, -1.5)) * (1 + _smooth("ret" + site["name"], t, 1800, 0.12) + _noise("ret" + site["name"], t / 300, 0.03))


def _ilm(kind: str, t: float) -> float:
    client = 1.8e6 * (0.3 + _diurnal(t, 1.0)) * (1 + _smooth("ilmc", t, 2400, 0.2))
    background = 6.5e6 + 2.5e6 * math.sin(t / 50000.0) + _smooth("ilmb", t, 3600, 6e5)
    if kind == "client":
        return client
    if kind == "background":
        return background
    return client + background


_KEYSPACES = {"storagegrid": 0.0, "reaper_db": 1.7, "s3_batch": 3.1}


def _reaper(ks: str, t: float) -> float:
    # Each keyspace repairs on a ~10 h cycle; dips then climbs back to 100 %.
    cycle = 36000.0
    pos = ((t / cycle) + _KEYSPACES[ks] / 10) % 1.0
    if pos < 0.15:
        return 100.0
    return min(100.0, 55.0 + 45.0 * ((pos - 0.15) / 0.85) ** 0.6)


# ── Metric dispatch ───────────────────────────────────────────────────────────
def _v(labels: dict, value: float) -> dict:
    return {"metric": labels, "value": [time.time(), str(value)]}


def _site_labels(s: dict) -> dict:
    return {"site_name": s["name"], "site_id": s["id"]}


def _storage_nodes():
    return [n for n in NODES if n["type"] == "storageNode"]


def _instant(promql: str) -> list[dict]:
    q = promql.replace(" ", "")
    now = time.time()

    if q == "node_dmi_info":
        return [_v({"node_id": n["id"], "product_name": n["model"], "chassis_version": n["model"],
                    "board_serial": n["board_serial"], "bios_version": n["bios"],
                    "system_vendor": "NetApp"}, 1)
                for n in NODES if n["state"] == "connected"]
    if q == "storagegrid_appliance_storage_controller_hardware_sensor":
        return [_v({"node_id": n["id"], "chassis_serial_number": n["chassis_serial"]}, 1)
                for n in _storage_nodes()]
    if "storagegrid_appliance_shelf_status" in q:
        return [_v({"node_id": n["id"]}, n["shelves"]) for n in _storage_nodes() if n["shelves"]]

    # Per-node storage
    if q.startswith("sumby(node_id)(storagegrid_storage_utilization_data_bytes"):
        return [_v({"node_id": n["id"]}, n["capacity"] * n["fill"] / 100) for n in _storage_nodes()]
    if q.startswith("sumby(node_id)(storagegrid_storage_utilization_usable_space_bytes"):
        return [_v({"node_id": n["id"]}, n["capacity"] * (1 - n["fill"] / 100)) for n in _storage_nodes()]

    # Per-site storage
    if q.startswith("sumby(site_name,site_id)(storagegrid_storage_utilization_"):
        out = []
        for s in SITES:
            members = [n for n in _storage_nodes() if n["siteId"] == s["id"]]
            used = sum(n["capacity"] * n["fill"] / 100 for n in members)
            usable = sum(n["capacity"] * (1 - n["fill"] / 100) for n in members)
            total = (used + usable) * 1.04
            val = used if "data_bytes" in q else usable if "usable_space" in q else total
            out.append(_v(_site_labels(s), val))
        return out

    # Per-site network traffic
    if "node_network_" in q or "storagegrid_network_" in q:
        inbound = "receive" in q or "received" in q
        out = []
        for s in SITES:
            client = _site_ingest(s, now) if inbound else _site_retrieve(s, now)
            # Grid network: replication / EC fragments between sites.
            grid = (_site_ingest(s, now) * 1.6 + 220 * MB) * (1 + _noise("grid" + s["name"] + str(inbound), now / 60, 0.1))
            if 'device="eth0"' in promql:
                val = grid
            elif 'device="eth2"' in promql:
                val = client
            else:
                val = grid + client
            out.append(_v(_site_labels(s), val))
        return out

    # Inter-site latency (remote config round trip)
    if "storagegrid_go_remote_config_time_ms" in q:
        return [_v(_site_labels(s), s["latency"] * (1 + _noise("lat" + s["name"], now / 60, 0.15)))
                for s in SITES]

    # Tenant usage
    if "storagegrid_tenant_usage_data_bytes" in q:
        return [_v({"tenant_id": t["id"]}, _tenant_bytes(t, now)) for t in TENANTS]
    if "storagegrid_tenant_usage_object_count" in q:
        return [_v({"tenant_id": t["id"]},
                   int(sum(_bucket_bytes(b, now) / b["avg_obj"] for b in t["buckets"]))) for t in TENANTS]
    if "storagegrid_tenant_usage_quota_bytes" in q:
        return [_v({"tenant_id": t["id"]}, t["quota"]) for t in TENANTS if t["quota"]]

    return []


def _range(promql: str, start: int, end: int, step: int) -> list[dict]:
    q = promql.replace(" ", "")
    ts = list(range(int(start), int(end) + 1, max(1, int(step))))

    def series(labels: dict, fn) -> dict:
        return {"metric": labels, "values": [[t, str(fn(t))] for t in ts]}

    if "s3_data_transfers_bytes_ingested" in q or "s3_data_transfers_bytes_retrieved" in q:
        fn = _site_ingest if "ingested" in q else _site_retrieve
        if q.startswith("sumby(site_name)"):
            return [series({"site_name": s["name"]}, lambda t, s=s: fn(s, t)) for s in SITES]
        return [series({}, lambda t: sum(fn(s, t) for s in SITES))]
    if "ilm_awaiting_client_objects" in q:
        return [series({}, lambda t: _ilm("client", t))]
    if "ilm_awaiting_background_objects" in q:
        return [series({}, lambda t: _ilm("background", t))]
    if "ilm_awaiting_total_objects" in q:
        return [series({}, lambda t: _ilm("total", t))]
    if "cassandra_repair_repaired_percent" in q:
        if q.startswith("avgby(keyspace)"):
            return [series({"keyspace": ks}, lambda t, ks=ks: _reaper(ks, t)) for ks in _KEYSPACES]
        return [series({}, lambda t: min(_reaper(ks, t) for ks in _KEYSPACES))]
    if "cassandra_repair_reaper_reachable" in q:
        return [series({}, lambda t: len(SITES))]
    if "storagegrid_tenant_usage_data_bytes" in q:
        return [series({"tenant_id": tn["id"]}, lambda t, tn=tn: _tenant_bytes(tn, t)) for tn in TENANTS]
    return []


# ── Fake HTTP layer ───────────────────────────────────────────────────────────
class _Resp:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"demo: HTTP {self.status_code}")


def _calc_time() -> str:
    # The grid recalculates bucket usage periodically; pretend it ran 40 min ago.
    return (datetime.now(timezone.utc) - timedelta(minutes=40)).isoformat().replace("+00:00", "Z")


class DemoClient:
    """Drop-in replacement for client.StorageGridClient."""

    base_url = "https://admin01.grid.example.com"

    def __init__(self):
        self.token = "demo"

    def authenticate(self) -> None:
        self.token = "demo"

    def get_raw(self, path: str, params: dict | None = None, timeout: int = 20) -> _Resp:
        path = path.split("?", 1)[0].rstrip("/")
        if path == "/grid/node-health":
            return _Resp(self.get_node_health())
        if path == "/grid/health/topology":
            return _Resp(self.get_health_topology())
        if path == "/grid/alerts":
            return _Resp(self.get_alerts())
        if path == "/grid/accounts":
            return _Resp({"data": [{"id": t["id"], "name": t["name"]} for t in TENANTS]})
        if path.startswith("/grid/accounts/"):
            parts = path.split("/")
            tn = _TENANT_BY_ID.get(parts[3])
            if not tn:
                return _Resp({"message": "not found"}, 404)
            if len(parts) == 5 and parts[4] == "usage":
                now = time.time()
                return _Resp({"data": {
                    "calculationTime": _calc_time(),
                    "buckets": [{"name": b["name"], "dataBytes": int(_bucket_bytes(b, now)),
                                 "objectCount": int(_bucket_bytes(b, now) / b["avg_obj"])}
                                for b in tn["buckets"]],
                }})
            return _Resp({"data": {"id": tn["id"], "name": tn["name"]}})
        return _Resp({"message": "not found"}, 404)

    def get_health_topology(self) -> dict:
        children = []
        for s in SITES:
            members = [n for n in NODES if n["siteId"] == s["id"]]
            worst = max((_node_severity(n) for n in members), key=lambda x: _SEV_RANK[x])
            children.append({
                "type": "site", "id": s["id"], "name": s["name"], "severity": worst,
                "children": [{"id": n["id"], "name": n["name"]} for n in members],
            })
        return {"data": {"type": "grid", "name": "demo-grid", "children": children}}

    def get_node_health(self) -> dict:
        return {"data": [{
            "id": n["id"], "name": n["name"], "type": n["type"],
            "severity": _node_severity(n), "state": n["state"],
            "siteId": n["siteId"], "siteName": n["siteName"],
            "isPrimaryAdmin": n["isPrimaryAdmin"],
        } for n in NODES]}

    def get_alerts(self) -> dict:
        return {"data": _alerts()}

    def get_health(self) -> dict:
        return {"data": {"alerts": {"critical": 1, "major": 2, "minor": 3}}}

    def query_metrics(self, promql: str, timeout: int = 10) -> list[dict]:
        return _instant(promql)

    def query_range(self, promql: str, start: int, end: int, step: int,
                    timeout: int = 20) -> list[dict]:
        return _range(promql, start, end, step)


def ip_for(fqdn: str) -> str | None:
    return _IPS.get(fqdn.split(".", 1)[0])


async def seed_bucket_history(days: int = 30, every_hours: int = 6) -> None:
    """Pre-fill bucket snapshots so the bucket charts have history on first start."""
    from sqlalchemy import func, select

    from database import AsyncSessionLocal
    from models import BucketSnapshot

    async with AsyncSessionLocal() as s:
        if (await s.execute(select(func.count()).select_from(BucketSnapshot))).scalar():
            return
        now = time.time()
        for k in range(days * 24 // every_hours, 0, -1):
            t = now - k * every_hours * 3600
            captured = datetime.fromtimestamp(t, timezone.utc)
            for tn in TENANTS:
                for b in tn["buckets"]:
                    size = _bucket_bytes(b, t) * (1 + _noise("b" + b["name"], t / 3600, 0.002))
                    s.add(BucketSnapshot(
                        tenant_id=tn["id"], tenant_name=tn["name"], bucket_name=b["name"],
                        data_bytes=int(size), object_count=int(size / b["avg_obj"]),
                        calculation_time=captured, captured_at=captured,
                    ))
        await s.commit()
