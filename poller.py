import asyncio
import json
import logging
import socket
from urllib.parse import urlparse
from fastapi import WebSocket
from client import StorageGridClient, get_client
import config

logger = logging.getLogger(__name__)

_snapshot: dict = {}
_clients: set[WebSocket] = set()
_ip_cache: dict[str, str] = {}   # fqdn -> resolved IPv4


def _domain_from_base_url() -> str:
    parsed = urlparse(config.SGRID_URL)
    parts = parsed.netloc.split(".")
    return ".".join(parts[1:]) if len(parts) > 1 else parsed.netloc


def _resolve_ip(fqdn: str) -> str | None:
    if config.DEMO:
        import demo
        return demo.ip_for(fqdn)
    if fqdn in _ip_cache:
        return _ip_cache[fqdn]
    try:
        ip = socket.gethostbyname(fqdn)
        _ip_cache[fqdn] = ip
        return ip
    except Exception:
        _ip_cache[fqdn] = ""
        return None


def get_snapshot() -> dict:
    return _snapshot


def add_client(ws: WebSocket) -> None:
    _clients.add(ws)


def remove_client(ws: WebSocket) -> None:
    _clients.discard(ws)


async def _broadcast(data: dict) -> None:
    msg = json.dumps(data)
    dead: set[WebSocket] = set()
    for ws in list(_clients):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)


def _severity_rank(severity: str) -> int:
    # StorageGRID uses "normal" as the healthy state — same rank as "notice".
    return {"critical": 4, "major": 3, "minor": 2, "warning": 1, "notice": 0, "normal": 0}.get(severity, -1)


def _severity_to_health(severity: str) -> str:
    rank = _severity_rank(severity)
    if rank >= 3:
        return "critical"
    if rank >= 1:
        return "warning"
    if rank == 0:
        return "ok"      # "normal" or "notice"
    return "unknown"


def _build_snapshot(topology: dict, node_health_resp: dict, alerts_resp: dict) -> dict:
    alerts: list[dict] = alerts_resp.get("data", []) or []
    node_health_list: list[dict] = node_health_resp.get("data", []) or []

    # Index active alerts by node_id (stored in labels.node_id)
    alerts_by_node: dict[str, list[dict]] = {}
    for alert in alerts:
        if alert.get("status") != "active":
            continue
        labels = alert.get("labels", {})
        nid = labels.get("node_id", "")
        if nid:
            alerts_by_node.setdefault(nid, []).append({
                "id": alert.get("id", ""),
                "name": alert.get("name", ""),
                "severity": labels.get("severity", "notice"),
                "service": labels.get("service", ""),
                "summary": alert.get("annotations", {}).get("description", ""),
                "recommendedActions": alert.get("annotations", {}).get("recommendedActions", ""),
                "triggeredAt": alert.get("startsAt", ""),
                "silenced": alert.get("silenced", False),
            })

    # node-health is the authoritative source: type, severity, state, siteId
    nh_by_id: dict[str, dict] = {n.get("id", ""): n for n in node_health_list}

    # Build site list from topology (preserves order)
    grid = topology.get("data", {})
    sites: list[dict] = []
    site_node_ids: dict[str, list[str]] = {}

    for site_entry in grid.get("children", []):
        if site_entry.get("type") != "site":
            continue
        site_id = site_entry.get("id", "")
        site_name = site_entry.get("name", "")
        sites.append({
            "id": site_id,
            "name": site_name,
            "health": _severity_to_health(site_entry.get("severity", "normal")),
        })
        site_node_ids[site_id] = [
            child.get("id", "") for child in site_entry.get("children", [])
        ]

    # Build nodes from node-health (most complete source)
    nodes: list[dict] = []
    for nh in node_health_list:
        node_id = nh.get("id", "")
        node_alerts = alerts_by_node.get(node_id, [])

        # Derive health: use node's own severity, then escalate from alerts
        base_health = _severity_to_health(nh.get("severity", "normal"))
        is_connected = nh.get("state", "connected") == "connected"
        if not is_connected:
            health = "unknown"
        elif node_alerts:
            max_rank = max(_severity_rank(a["severity"]) for a in node_alerts)
            health = "critical" if max_rank >= 3 else "warning" if max_rank >= 1 else base_health
        else:
            health = base_health

        # Derive service health from alerts (only affected services visible)
        services_map: dict[str, str] = {}
        for a in node_alerts:
            svc = a.get("service", "")
            if svc:
                rank = _severity_rank(a["severity"])
                existing = _severity_rank(services_map.get(svc, "normal"))
                if rank > existing:
                    services_map[svc] = a["severity"]

        services = [
            {"name": svc, "health": _severity_to_health(sev)}
            for svc, sev in sorted(services_map.items())
        ]

        node_alerts.sort(key=lambda a: -_severity_rank(a["severity"]))

        node_name = nh.get("name", "")
        domain = _domain_from_base_url()
        fqdn = f"{node_name}.{domain}" if node_name and domain else ""

        nodes.append({
            "id": node_id,
            "name": node_name,
            "siteId": nh.get("siteId", ""),
            "siteName": nh.get("siteName", ""),
            "type": nh.get("type", "node"),
            "health": health,
            "isConnected": is_connected,
            "isPrimaryAdmin": nh.get("isPrimaryAdmin", False),
            "fqdn": fqdn,
            "ip": _resolve_ip(fqdn) if fqdn else None,
            "alertCount": len(node_alerts),
            "alerts": node_alerts,
            "services": services,
        })

    # All-pairs site links
    links: list[dict] = []
    for i, s1 in enumerate(sites):
        for s2 in sites[i + 1:]:
            links.append({"source": s1["id"], "target": s2["id"], "weight": 1.0})

    return {"sites": sites, "nodes": nodes, "links": links}


def _fetch_hardware(client: StorageGridClient) -> dict[str, dict]:
    """Returns {node_id: {model, chassis_version, board_serial, bios_version,
                          shelf_count, storage_chassis_serial}}.
    Most fields come from node_dmi_info (only available on nodes with the
    newer node_exporter). storage_chassis_serial and shelf_count come from
    StorageGRID-specific appliance metrics and are available on all appliances.
    """
    info: dict[str, dict] = {}

    # node_dmi_info — full hardware identification (only some nodes)
    try:
        for item in client.query_metrics("node_dmi_info"):
            m = item["metric"]
            nid = m.get("node_id", "")
            if not nid:
                continue
            info.setdefault(nid, {})
            info[nid].update({
                "model": m.get("product_name") or m.get("chassis_version"),
                "chassis_version": m.get("chassis_version"),
                "board_serial": m.get("board_serial"),
                "bios_version": m.get("bios_version"),
                "vendor": m.get("system_vendor") or m.get("chassis_vendor"),
            })
    except Exception as e:
        logger.warning("node_dmi_info query failed: %s", e)

    # Storage chassis serial via the controller hardware sensor (most appliances)
    try:
        for item in client.query_metrics("storagegrid_appliance_storage_controller_hardware_sensor"):
            m = item["metric"]
            nid = m.get("node_id", "")
            cs = (m.get("chassis_serial_number") or "").strip()
            if nid and cs:
                info.setdefault(nid, {})
                info[nid].setdefault("storage_chassis_serial", cs)
    except Exception:
        pass

    # Number of expansion shelves attached
    try:
        shelves = client.query_metrics("count by(node_id)(storagegrid_appliance_shelf_status)")
        for item in shelves:
            nid = item["metric"].get("node_id", "")
            if nid:
                info.setdefault(nid, {})
                info[nid]["shelf_count"] = int(float(item["value"][1]))
    except Exception:
        pass

    # Storage controller firmware (E-Series controller behind SG appliances).
    # Versions are exposed as labels; StorageGRID only reports controller A.
    try:
        res = client.query_metrics(
            "storagegrid_appliance_storage_controller_firmware_version or "
            "storagegrid_appliance_storage_controller_nvsram_version")
        for item in res:
            m = item["metric"]
            nid = m.get("node_id", "")
            if not nid:
                continue
            name = m.get("__name__", "")
            if name.endswith("firmware_version"):
                fw, osv = m.get("CFW"), m.get("BundleDisplayVersion")
                if fw or osv:
                    info.setdefault(nid, {})
                    if fw:
                        info[nid]["storage_controller_firmware"] = fw
                    if osv:
                        info[nid]["storage_controller_os_version"] = osv
            elif name.endswith("nvsram_version") and m.get("NVSRAM"):
                info.setdefault(nid, {})
                info[nid]["storage_controller_nvsram"] = m["NVSRAM"]
    except Exception as e:
        logger.warning("storage controller firmware query failed: %s", e)

    return info


def _do_poll() -> dict:
    _client = get_client("poller")
    topology = _client.get_health_topology()
    node_health = _client.get_node_health()
    alerts = _client.get_alerts()

    # Per-node storage usage % using NetApp Grid Manager formula:
    #   used_pct = data / (data + usable)
    node_storage_pct: dict[str, float] = {}
    try:
        used = _client.query_metrics(
            "sum by(node_id)(storagegrid_storage_utilization_data_bytes)"
        )
        usable = _client.query_metrics(
            "sum by(node_id)(storagegrid_storage_utilization_usable_space_bytes)"
        )
        used_map   = {i["metric"].get("node_id", ""): float(i["value"][1]) for i in used}
        usable_map = {i["metric"].get("node_id", ""): float(i["value"][1]) for i in usable}
        for nid, u in used_map.items():
            us = usable_map.get(nid, 0.0)
            denom = u + us
            if denom > 0:
                node_storage_pct[nid] = round(u / denom * 100, 1)
    except Exception as e:
        logger.warning("Per-node storage query failed: %s", e)

    hw_by_node = _fetch_hardware(_client)

    snapshot = _build_snapshot(topology, node_health, alerts)
    for node in snapshot.get("nodes", []):
        if node["id"] in node_storage_pct:
            node["storagePct"] = node_storage_pct[node["id"]]
        hw = hw_by_node.get(node["id"])
        if hw:
            node["hardware"] = hw
    return snapshot


async def poll_loop() -> None:
    global _snapshot
    while True:
        try:
            new_snapshot = await asyncio.to_thread(_do_poll)
            if new_snapshot != _snapshot:
                _snapshot = new_snapshot
                await _broadcast({"type": "snapshot", "data": new_snapshot})
                logger.info(
                    "Snapshot updated: %d nodes across %d sites",
                    len(new_snapshot["nodes"]),
                    len(new_snapshot["sites"]),
                )
        except Exception as exc:
            logger.error("Poll error: %s", exc)
            await _broadcast({"type": "error", "message": str(exc)})
        await config.sleep(config.POLL_INTERVAL)
