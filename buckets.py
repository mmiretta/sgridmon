"""Per-bucket usage history.

Since StorageGRID does NOT expose per-bucket metrics in Prometheus, we poll
/grid/accounts/{tenant_id}/usage periodically and store snapshots
locally. The grid itself recalculates bucket usage every several hours, so
polling more than once every couple of hours is wasteful.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

import config
from client import StorageGridClient, get_client
from database import AsyncSessionLocal
from models import BucketSnapshot
from sqlalchemy import select, delete, and_

logger = logging.getLogger(__name__)

# Poll interval and retention are read live from config.BUCKET_POLL_INTERVAL
# (default: every 2 hours) and config.BUCKET_RETENTION_DAYS (default: 90 days).

# Status of background poll loop, exposed at /api/tenants/buckets/status
_status: dict = {
    "last_run_started": None,
    "last_run_finished": None,
    "last_run_duration_s": None,
    "tenants_polled": 0,
    "buckets_recorded": 0,
    "next_run_est": None,
    "running": False,
}


def _client() -> StorageGridClient:
    return get_client("buckets")


def _fetch_with_reauth(c: StorageGridClient, path: str, params: dict | None = None):
    return c.get_raw(path, params=params, timeout=20)


async def _poll_all_tenants_once() -> tuple[int, int]:
    """Poll every tenant's /usage endpoint, persist bucket snapshots.
    Returns (tenants_processed, buckets_recorded)."""
    c = _client()
    # List tenants
    resp = _fetch_with_reauth(c, "/grid/accounts", {"limit": 1000})
    if resp.status_code != 200:
        logger.error("Accounts list failed: %s", resp.status_code)
        return (0, 0)
    accounts = resp.json().get("data", [])

    tenants_done = 0
    buckets_done = 0
    now = datetime.now(timezone.utc)

    for acct in accounts:
        tid = acct.get("id")
        if not tid:
            continue
        tname = acct.get("name") or tid
        try:
            r = _fetch_with_reauth(c, f"/grid/accounts/{tid}/usage")
            if r.status_code != 200:
                continue
            data = r.json().get("data", {})
            buckets = data.get("buckets", []) or []
            calc_time_str = data.get("calculationTime")
            calc_time = None
            if calc_time_str:
                try:
                    s = calc_time_str.replace("Z", "+00:00")
                    calc_time = datetime.fromisoformat(s)
                except Exception:
                    pass

            async with AsyncSessionLocal() as s:
                for b in buckets:
                    bname = b.get("name")
                    if not bname:
                        continue
                    s.add(BucketSnapshot(
                        tenant_id=tid,
                        tenant_name=tname,
                        bucket_name=bname,
                        data_bytes=int(b.get("dataBytes") or 0),
                        object_count=int(b.get("objectCount") or 0),
                        calculation_time=calc_time,
                        captured_at=now,
                    ))
                    buckets_done += 1
                await s.commit()
            tenants_done += 1
        except Exception as e:
            logger.warning("Failed tenant %s: %s", tid, e)
            continue
        # Slight pacing — be gentle on the admin API
        await asyncio.sleep(0.15)

    # Retention cleanup
    cutoff = now - timedelta(days=config.BUCKET_RETENTION_DAYS)
    try:
        async with AsyncSessionLocal() as s:
            await s.execute(delete(BucketSnapshot).where(BucketSnapshot.captured_at < cutoff))
            await s.commit()
    except Exception as e:
        logger.warning("Retention cleanup failed: %s", e)

    return (tenants_done, buckets_done)


async def poll_loop():
    """Long-running background task."""
    if config.DEMO:
        import demo
        await demo.seed_bucket_history()
    await asyncio.sleep(10)
    while True:
        started = datetime.now(timezone.utc)
        _status["last_run_started"] = started.isoformat()
        _status["running"] = True
        try:
            tenants, buckets = await _poll_all_tenants_once()
            finished = datetime.now(timezone.utc)
            _status.update({
                "last_run_finished":   finished.isoformat(),
                "last_run_duration_s": int((finished - started).total_seconds()),
                "tenants_polled":      tenants,
                "buckets_recorded":    buckets,
                "next_run_est":        (finished + timedelta(seconds=config.BUCKET_POLL_INTERVAL)).isoformat(),
            })
            logger.info("Bucket snapshot poll done: %d tenants, %d buckets in %ss",
                        tenants, buckets, _status["last_run_duration_s"])
        except Exception as e:
            logger.error("Bucket snapshot poll failed: %s", e)
        finally:
            _status["running"] = False
        await config.sleep(config.BUCKET_POLL_INTERVAL)


def get_status() -> dict:
    """Snapshot of background poll state, for the status endpoint."""
    return dict(_status)


# ── Queries used by the HTTP API ──

async def get_buckets_for_tenant(tenant_id: str, range_seconds: int) -> dict:
    """Return latest bucket list + history per bucket for the time window.
       Format:
         {
           "latest": [{name, data_bytes, object_count}, ...],
           "history": {bucket_name: [[t, data_bytes], ...]},
           "calculation_time": ISO string or None,
           "captured_at_latest": ISO string or None,
         }
    """
    since = datetime.now(timezone.utc) - timedelta(seconds=range_seconds)
    async with AsyncSessionLocal() as s:
        rows = (await s.execute(
            select(BucketSnapshot)
            .where(and_(
                BucketSnapshot.tenant_id == tenant_id,
                BucketSnapshot.captured_at >= since,
            ))
            .order_by(BucketSnapshot.captured_at.asc())
        )).scalars().all()

    history: dict[str, list[list[float]]] = {}
    latest_per_bucket: dict[str, dict] = {}
    calc_time = None
    captured_latest = None

    for r in rows:
        history.setdefault(r.bucket_name, []).append(
            [r.captured_at.timestamp(), float(r.data_bytes)]
        )
        # Keep updating "latest" so the very last row wins
        latest_per_bucket[r.bucket_name] = {
            "name": r.bucket_name,
            "data_bytes": r.data_bytes,
            "object_count": r.object_count,
        }
        if r.calculation_time:
            calc_time = r.calculation_time
        captured_latest = r.captured_at

    latest_sorted = sorted(latest_per_bucket.values(), key=lambda b: -b["data_bytes"])

    return {
        "tenant_id":           tenant_id,
        "range_seconds":       range_seconds,
        "latest":              latest_sorted,
        "history":             history,
        "calculation_time":    calc_time.isoformat() if calc_time else None,
        "captured_at_latest":  captured_latest.isoformat() if captured_latest else None,
        "snapshot_count":      len({r.captured_at for r in rows}),
    }


async def refresh_tenant_now(tenant_id: str) -> dict:
    """Force an immediate refresh for a single tenant — used when user expands a row
    and the latest snapshot is stale or missing."""
    c = _client()
    r = _fetch_with_reauth(c, f"/grid/accounts/{tenant_id}")
    if r.status_code != 200:
        return {"ok": False, "error": f"account fetch {r.status_code}"}
    tname = (r.json().get("data") or {}).get("name") or tenant_id

    r2 = _fetch_with_reauth(c, f"/grid/accounts/{tenant_id}/usage")
    if r2.status_code != 200:
        return {"ok": False, "error": f"usage fetch {r2.status_code}"}
    data = r2.json().get("data", {})
    buckets = data.get("buckets", []) or []
    calc_time_str = data.get("calculationTime")
    calc_time = None
    if calc_time_str:
        try:
            calc_time = datetime.fromisoformat(calc_time_str.replace("Z", "+00:00"))
        except Exception:
            pass
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as s:
        for b in buckets:
            bname = b.get("name")
            if not bname:
                continue
            s.add(BucketSnapshot(
                tenant_id=tenant_id,
                tenant_name=tname,
                bucket_name=bname,
                data_bytes=int(b.get("dataBytes") or 0),
                object_count=int(b.get("objectCount") or 0),
                calculation_time=calc_time,
                captured_at=now,
            ))
        await s.commit()
    return {"ok": True, "buckets_count": len(buckets)}
