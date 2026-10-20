"""Settings API (admin only): read and edit the configuration file from the UI."""
import asyncio
import logging
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

import auth
import charts
import client
import config
import tenants

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", dependencies=[Depends(auth.require_admin)])

_write_lock = asyncio.Lock()


class DatabaseIn(BaseModel):
    mode: str = "bundled"            # bundled | external
    host: str = ""
    port: Optional[int] = 5432
    database: str = "sgridmon"
    user: str = ""
    password: str = ""               # empty = keep the current one


class SettingsIn(BaseModel):
    values: dict[str, object] = {}
    database: Optional[DatabaseIn] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _bundled_url() -> str:
    return config.base_raw("DATABASE_URL") or config.FIELDS_BY_KEY["DATABASE_URL"].default


def _mask_url(url: str) -> str:
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return "(invalid URL)"


def _db_info(file_values: dict, effective: dict) -> dict:
    external = "DATABASE_URL" in file_values and file_values["DATABASE_URL"].strip() != ""
    info = {
        "mode": "external" if external else "bundled",
        "bundled_url": _mask_url(_bundled_url()),
        "bundled_from_env": config.base_raw("DATABASE_URL") is not None,
        "external": {"host": "", "port": 5432, "database": "sgridmon", "user": "",
                     "password_set": False},
        "restart_pending": effective["DATABASE_URL"] != config.RUNNING.get("DATABASE_URL"),
    }
    if external:
        try:
            u = make_url(file_values["DATABASE_URL"])
            info["external"] = {
                "host": u.host or "", "port": u.port or 5432,
                "database": u.database or "", "user": u.username or "",
                "password_set": bool(u.password),
            }
        except Exception:
            pass
    return info


def _source(key: str, file_values: dict) -> str:
    if key in file_values:
        return "file"
    if config.base_raw(key) is not None:
        return "environment"
    return "default"


def _payload() -> dict:
    file_values = config.read_file()
    effective = config.resolve(file_values)
    groups = []
    for g in config.GROUPS:
        fields = []
        for f in (x for x in config.FIELDS if x.group == g):
            item = {
                "key": f.key, "type": f.type, "description": f.description,
                "default": None if f.type == "secret" else f.default,
                "optional": f.optional,
                "restart_required": f.restart,
                "source": _source(f.key, file_values),
            }
            if f.type == "secret":
                item["set"] = bool(effective[f.key])
            else:
                item["value"] = effective[f.key]
            if f.restart:
                item["restart_pending"] = effective[f.key] != config.RUNNING.get(f.key)
            fields.append(item)
        groups.append({"name": g, "fields": fields})
    return {
        "config_path": config.CONFIG_PATH,
        "demo": config.DEMO,
        "groups": groups,
        "database": _db_info(file_values, effective),
    }


def _validate(key: str, value) -> str:
    """Return the raw string to store for ``key``; raise HTTPException if invalid."""
    f = config.FIELDS_BY_KEY.get(key)
    if f is None or key == "DATABASE_URL":
        raise HTTPException(400, f"unknown setting: {key}")
    if value is None:
        value = ""
    if f.type == "bool":
        if isinstance(value, bool):
            return "true" if value else "false"
        s = str(value).strip().lower()
        if s in ("1", "true", "yes", "on"):
            return "true"
        if s in ("0", "false", "no", "off", ""):
            return "false"
        raise HTTPException(400, f"{key}: expected true or false")
    s = str(value).strip()
    if "\n" in s or "\r" in s:
        raise HTTPException(400, f"{key}: newlines are not allowed")
    if f.type == "int":
        try:
            n = int(s)
        except ValueError:
            raise HTTPException(400, f"{key}: expected a whole number")
        if n <= 0:
            raise HTTPException(400, f"{key}: must be greater than 0")
        return str(n)
    if f.type == "float":
        try:
            x = float(s)
        except ValueError:
            raise HTTPException(400, f"{key}: expected a number")
        if not x > 0:
            raise HTTPException(400, f"{key}: must be greater than 0")
        return str(x)
    if f.type == "url":
        if s == "" and f.optional:
            return ""
        p = urlparse(s)
        if p.scheme not in ("http", "https") or not p.netloc:
            raise HTTPException(400, f"{key}: expected an http(s):// URL")
        return s.rstrip("/") if key == "SGRID_URL" else s
    if key == "SGRID_API_VERSION" and not s.isdigit():
        raise HTTPException(400, f"{key}: expected a number such as 4")
    if s == "" and not f.optional and f.type != "secret":
        raise HTTPException(400, f"{key}: cannot be empty")
    return s


def _external_url(db: DatabaseIn, current_url: str | None) -> str:
    host = db.host.strip()
    if not host:
        raise HTTPException(400, "database host is required")
    if not db.user.strip():
        raise HTTPException(400, "database user is required")
    if not db.database.strip():
        raise HTTPException(400, "database name is required")
    port = db.port or 5432
    if not (0 < port < 65536):
        raise HTTPException(400, "database port must be between 1 and 65535")
    password = db.password
    if not password and current_url:
        try:
            password = make_url(current_url).password or ""
        except Exception:
            password = ""
    from sqlalchemy.engine import URL
    return URL.create(
        "postgresql+asyncpg", username=db.user.strip(), password=password or None,
        host=host, port=port, database=db.database.strip(),
    ).render_as_string(hide_password=False)


def _apply_changes(body: SettingsIn, file_values: dict) -> dict:
    """Return the new raw file contents for ``body`` (does not write)."""
    new = dict(file_values)
    for key, value in body.values.items():
        f = config.FIELDS_BY_KEY.get(key)
        raw = _validate(key, value)
        if f.type == "secret" and raw == "":
            continue                    # empty secret = keep unchanged
        if key in config.ENV_MANAGED:
            base = config.base_raw(key)
            base_val = config._coerce(f, base)
            if config._coerce(f, raw) == base_val:
                new.pop(key, None)      # same as environment: no override
                continue
        new[key] = raw
    if body.database is not None:
        if body.database.mode == "bundled":
            new.pop("DATABASE_URL", None)
        elif body.database.mode == "external":
            current = file_values.get("DATABASE_URL") or None
            new["DATABASE_URL"] = _external_url(body.database, current)
        else:
            raise HTTPException(400, "database mode must be bundled or external")
    return new


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
async def get_settings():
    return _payload()


@router.put("")
async def put_settings(body: SettingsIn):
    async with _write_lock:
        file_values = config.read_file()
        before = config.resolve(file_values)
        new_values = _apply_changes(body, file_values)
        after = config.resolve(new_values)
        changed = [k for k in after if after[k] != before[k]]
        if new_values != file_values:
            try:
                await asyncio.to_thread(config.write_file, new_values)
            except OSError as e:
                logger.error("Cannot write config file %s: %s", config.CONFIG_PATH, e)
                raise HTTPException(500, f"cannot write config file: {e}")
        config.reload()
        client.reset_clients()
        if any(config.FIELDS_BY_KEY[k].group == "StorageGRID" for k in changed):
            tenants.reset_cache()
            charts.reset_cache()
        if changed:
            logger.info("Settings changed by admin: %s", ", ".join(changed))
    restart = [k for k in changed if config.FIELDS_BY_KEY[k].restart]
    out = _payload()
    out.update({"ok": True, "changed": changed, "restart_required": restart})
    return out


@router.post("/test")
async def test_storagegrid(body: SettingsIn):
    """Try to log in to StorageGRID with the submitted (unsaved) values."""
    if config.DEMO:
        return {"ok": True, "message": "Demo mode: no StorageGRID is contacted."}
    current = config.resolve()
    vals = {}
    for key in ("SGRID_URL", "SGRID_USER", "SGRID_PASS", "SGRID_API_VERSION",
                "SGRID_VERIFY_TLS", "SGRID_CA_BUNDLE", "SGRID_PROXY"):
        f = config.FIELDS_BY_KEY[key]
        if key in body.values:
            raw = _validate(key, body.values[key])
            vals[key] = current[key] if (f.type == "secret" and raw == "") else config._coerce(f, raw)
        else:
            vals[key] = current[key]

    def _try():
        c = client.make_client(
            base_url=vals["SGRID_URL"], username=vals["SGRID_USER"],
            password=vals["SGRID_PASS"], proxy=vals["SGRID_PROXY"],
            verify_tls=vals["SGRID_VERIFY_TLS"], ca_bundle=vals["SGRID_CA_BUNDLE"],
            api_version=vals["SGRID_API_VERSION"],
        )
        c.authenticate()
        c.get_health()

    try:
        await asyncio.wait_for(asyncio.to_thread(_try), timeout=45)
    except asyncio.TimeoutError:
        return {"ok": False, "message": "Timed out connecting to StorageGRID."}
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        if vals["SGRID_PASS"]:
            msg = msg.replace(vals["SGRID_PASS"], "***")
        return {"ok": False, "message": msg[:400]}
    return {"ok": True, "message": f"Logged in to {vals['SGRID_URL']} as {vals['SGRID_USER']}."}


@router.post("/test-db")
async def test_database(body: DatabaseIn):
    """Open a connection to the submitted database and run SELECT 1."""
    if body.mode == "bundled":
        url = _bundled_url()
    else:
        url = _external_url(body, config.read_file().get("DATABASE_URL") or None)
    try:
        u = make_url(url)
    except Exception:
        return {"ok": False, "message": "Invalid database URL."}
    connect_args = {"timeout": 5} if u.drivername.endswith("asyncpg") else {}
    engine = create_async_engine(url, connect_args=connect_args, pool_pre_ping=False)
    try:
        async def _q():
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        await asyncio.wait_for(_q(), timeout=8)
    except asyncio.TimeoutError:
        return {"ok": False, "message": "Timed out connecting to the database."}
    except Exception as e:
        msg = str(e).splitlines()[0] if str(e) else e.__class__.__name__
        if u.password:
            msg = msg.replace(u.password, "***")
        return {"ok": False, "message": msg[:400]}
    finally:
        await engine.dispose()
    return {"ok": True, "message": f"Connected to {_mask_url(url)}."}
