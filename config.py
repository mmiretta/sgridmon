"""Runtime configuration.

Values are resolved with this precedence (later wins):

    built-in defaults  <  environment variables (or a local .env)  <  config file

The config file (``config/sgridmon.env`` next to this module, or the path in
``SGRIDMON_CONFIG``) is editable from the web UI (Settings). On first start, if it
does not exist, it is created from the current effective values so that
environment-based installs carry over.

Settings marked ``restart`` are only read at start-up; the rest are applied live
by :func:`reload`.
"""
import logging
import os
import secrets
import tempfile
import time
from dataclasses import dataclass

from dotenv import dotenv_values, load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

CONFIG_PATH = os.getenv("SGRIDMON_CONFIG") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "config", "sgridmon.env"
)


@dataclass(frozen=True)
class Field:
    key: str           # name in the environment / config file
    attr: str          # module global in this module
    group: str
    type: str          # str | int | float | bool | url | secret
    default: object
    description: str
    restart: bool = False
    optional: bool = False   # empty value allowed (str/url)


GROUPS = ["StorageGRID", "Polling", "Display", "Web / auth", "Database"]

FIELDS: list[Field] = [
    # ── StorageGRID ──
    Field("SGRID_URL", "SGRID_URL", "StorageGRID", "url", "https://admin01.grid.example.com",
          "Base URL of an Admin Node (Grid Manager). Node FQDNs are built as "
          "<node-name>.<domain of this URL>."),
    Field("SGRID_USER", "SGRID_USER", "StorageGRID", "str", "sgridmon",
          "Local grid user. Read-only access is enough; root is not needed."),
    Field("SGRID_PASS", "SGRID_PASS", "StorageGRID", "secret", "",
          "Password of the grid user."),
    Field("SGRID_API_VERSION", "SGRID_API_VERSION", "StorageGRID", "str", "4",
          "Grid Management API version (sgridmon requires v4, StorageGRID 11.8 or later)."),
    Field("SGRID_VERIFY_TLS", "SGRID_VERIFY_TLS", "StorageGRID", "bool", True,
          "Verify the Admin Node TLS certificate. Disable for self-signed certificates."),
    Field("SGRID_CA_BUNDLE", "SGRID_CA_BUNDLE", "StorageGRID", "str", "",
          "Optional CA bundle (path inside the container) used when TLS verification is on.",
          optional=True),
    Field("SGRID_PROXY", "SGRID_PROXY", "StorageGRID", "url", "",
          "Optional proxy for StorageGRID API calls only, e.g. http://proxy.example.com:3128",
          optional=True),
    Field("SGRIDMON_DEMO", "DEMO", "StorageGRID", "bool", False,
          "Demo mode: serve a synthetic 3-site grid instead of contacting StorageGRID.",
          restart=True),
    # ── Polling ──
    Field("POLL_INTERVAL", "POLL_INTERVAL", "Polling", "int", 60,
          "Seconds between topology / node health / alerts polls."),
    Field("METRICS_INTERVAL", "METRICS_INTERVAL", "Polling", "int", 60,
          "Seconds between traffic / storage / latency metric polls."),
    Field("BUCKET_POLL_INTERVAL", "BUCKET_POLL_INTERVAL", "Polling", "int", 7200,
          "Seconds between per-bucket usage snapshots (the grid recalculates these slowly)."),
    Field("BUCKET_RETENTION_DAYS", "BUCKET_RETENTION_DAYS", "Polling", "int", 90,
          "Days of bucket usage history kept in the database."),
    # ── Display ──
    Field("EC_OVERHEAD", "EC_OVERHEAD", "Display", "float", 1.5,
          "Physical/logical ratio shown in the tenants table (depends on your ILM policy: "
          "erasure coding 4+2 = 1.5, two replicas = 2.0, ...)."),
    # ── Web / auth ──
    Field("SECRET_KEY", "SECRET_KEY", "Web / auth", "secret", "",
          "Key used to sign session cookies. Changing it signs everybody out.",
          restart=True),
    Field("SESSION_COOKIE_SECURE", "SESSION_COOKIE_SECURE", "Web / auth", "bool", False,
          "Mark the session cookie as Secure (enable when served over HTTPS).",
          restart=True),
    # ── Database ──
    Field("DATABASE_URL", "DATABASE_URL", "Database", "secret",
          "postgresql+asyncpg://sgridmon:sgridmon@localhost/sgridmon",
          "SQLAlchemy URL. Leave unset to use the bundled PostgreSQL (docker compose sets it).",
          restart=True),
]

FIELDS_BY_KEY = {f.key: f for f in FIELDS}

# Keys whose value normally comes from the environment (docker compose). They are
# only written to the config file when explicitly overridden.
ENV_MANAGED = {"DATABASE_URL", "SGRIDMON_DEMO"}

_TRUE = ("1", "true", "yes", "on")


def parse_bool(val, default: bool = False) -> bool:
    if val is None or str(val).strip() == "":
        return default
    return str(val).strip().lower() in _TRUE


def _coerce(field: Field, raw):
    """Convert a raw string to the field's type; empty/invalid → default."""
    if raw is None:
        return field.default
    raw = str(raw).strip()
    if field.type == "bool":
        return parse_bool(raw, field.default)
    if raw == "":
        return field.default if not field.optional else ""
    try:
        if field.type == "int":
            return int(raw)
        if field.type == "float":
            return float(raw)
    except ValueError:
        logger.warning("Invalid value for %s (%r); using default", field.key, raw)
        return field.default
    return raw


def read_file() -> dict[str, str]:
    """Raw key/value pairs present in the config file ({} if it does not exist)."""
    try:
        if not os.path.exists(CONFIG_PATH):
            return {}
        return {k: (v if v is not None else "") for k, v in dotenv_values(CONFIG_PATH).items()}
    except Exception as e:
        logger.error("Cannot read config file %s: %s", CONFIG_PATH, e)
        return {}


def base_raw(key: str):
    """Raw value from the environment (empty counts as unset), or None."""
    val = os.environ.get(key)
    if val is None or val.strip() == "":
        return None
    return val


def resolve(file_values: dict[str, str] | None = None) -> dict[str, object]:
    """Effective typed value of every field: defaults < environment < file."""
    if file_values is None:
        file_values = read_file()
    out = {}
    for f in FIELDS:
        raw = file_values[f.key] if f.key in file_values else base_raw(f.key)
        out[f.key] = _coerce(f, raw)
    return out


# Values in use by this process for restart-only settings (fixed at start-up).
RUNNING: dict[str, object] = {}
# Bumped on every reload so background loops can wake up early.
generation = 0


def _apply(values: dict[str, object], initial: bool) -> None:
    g = globals()
    for f in FIELDS:
        if f.restart and not initial:
            continue
        g[f.attr] = values[f.key]
        if f.restart:
            RUNNING[f.key] = values[f.key]


def reload() -> dict[str, object]:
    """Re-read environment + config file and update live settings."""
    global generation
    values = resolve()
    _apply(values, initial=False)
    generation += 1
    return values


async def sleep(seconds: float) -> None:
    """asyncio.sleep that returns early when the configuration is reloaded."""
    import asyncio
    start_gen = generation
    end = time.monotonic() + max(0.0, seconds)
    while generation == start_gen:
        left = end - time.monotonic()
        if left <= 0:
            return
        await asyncio.sleep(min(1.0, left))


# ── Writing the config file ───────────────────────────────────────────────────

def _quote(val: str) -> str:
    if "\n" in val or "\r" in val:
        raise ValueError("values cannot contain newlines")
    if val == "" or all(c.isalnum() or c in "-_.:/@+,=%~*" for c in val):
        return val
    return '"' + val.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _fmt(field: Field, val) -> str:
    if field.type == "bool":
        return "true" if val else "false"
    return str(val)


_GROUP_TITLES = {
    "StorageGRID": "StorageGRID",
    "Polling": "Polling (seconds)",
    "Display": "Display",
    "Web / auth": "Web / auth",
    "Database": "Database",
}


def write_file(values: dict[str, str]) -> None:
    """Atomically write the config file. ``values`` maps key → raw string; keys
    not present are written as commented-out defaults."""
    lines = [
        "# sgridmon configuration (editable from the web UI: Settings).",
        "# Values here override environment variables. Settings marked [restart]",
        "# take effect after restarting the container.",
        "",
    ]
    for group in GROUPS:
        title = _GROUP_TITLES[group]
        lines.append(f"# ── {title} " + "─" * max(3, 74 - len(title)))
        for f in (x for x in FIELDS if x.group == group):
            desc = f.description + (" [restart]" if f.restart else "")
            lines.append(f"# {desc}")
            if f.key in values:
                lines.append(f"{f.key}={_quote(str(values[f.key]))}")
            else:
                hint = "" if f.type == "secret" else _fmt(f, f.default)
                lines.append(f"# {f.key}={hint}")
        lines.append("")
    extra = {k: v for k, v in values.items() if k not in FIELDS_BY_KEY}
    if extra:
        lines.append("# ── Other " + "─" * 70)
        for k, v in extra.items():
            lines.append(f"{k}={_quote(str(v))}")
        lines.append("")

    directory = os.path.dirname(CONFIG_PATH) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".sgridmon.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write("\n".join(lines))
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_file() -> None:
    """Create the config file from the current effective values if missing."""
    if os.path.exists(CONFIG_PATH):
        return
    values = resolve({})
    raw: dict[str, str] = {}
    for f in FIELDS:
        if f.key in ENV_MANAGED:
            continue
        raw[f.key] = _fmt(f, values[f.key])
    if not raw.get("SECRET_KEY"):
        # Persist a signing key so sessions survive restarts.
        raw["SECRET_KEY"] = secrets.token_urlsafe(48)
    write_file(raw)
    logger.info("Created config file %s", CONFIG_PATH)


try:
    ensure_file()
except Exception as e:  # read-only filesystem, permissions...
    logger.warning("Config file %s not created: %s", CONFIG_PATH, e)

# Module globals (SGRID_URL, POLL_INTERVAL, DEMO, ...) are set from the fields.
_apply(resolve(), initial=True)

SGRID_URL: str
SGRID_USER: str
SGRID_PASS: str
SGRID_API_VERSION: str
SGRID_VERIFY_TLS: bool
SGRID_CA_BUNDLE: str
SGRID_PROXY: str
DEMO: bool
POLL_INTERVAL: int
METRICS_INTERVAL: int
BUCKET_POLL_INTERVAL: int
BUCKET_RETENTION_DAYS: int
EC_OVERHEAD: float
SECRET_KEY: str
SESSION_COOKIE_SECURE: bool
DATABASE_URL: str
