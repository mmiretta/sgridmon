"""Runtime configuration, read from environment variables (or a local .env file).

See .env.example for a documented list of every variable.
"""
import os

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


# ── StorageGRID connection ────────────────────────────────────────────────────
# Base URL of a StorageGRID Admin Node (Grid Manager), e.g. https://admin01.grid.example.com
SGRID_URL = os.getenv("SGRID_URL", "https://admin01.grid.example.com")
SGRID_USER = os.getenv("SGRID_USER", "sgridmon")
SGRID_PASS = os.getenv("SGRID_PASS", "")
# Grid Management API version. sgridmon targets v4 (StorageGRID 11.8+).
SGRID_API_VERSION = os.getenv("SGRID_API_VERSION", "4")
# Verify the Admin Node TLS certificate. Set to false for self-signed certificates.
SGRID_VERIFY_TLS = _bool("SGRID_VERIFY_TLS", True)
# Optional CA bundle used when SGRID_VERIFY_TLS is true.
SGRID_CA_BUNDLE = os.getenv("SGRID_CA_BUNDLE", "")
# Optional HTTP(S) proxy used only for StorageGRID API calls, e.g. http://proxy.example.com:3128
SGRID_PROXY = os.getenv("SGRID_PROXY", "")

# ── Polling ───────────────────────────────────────────────────────────────────
# Seconds between topology / node-health / alerts polls.
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "60"))
# Seconds between traffic / storage / latency metric polls.
METRICS_INTERVAL = int(os.getenv("METRICS_INTERVAL", "60"))
# Seconds between per-bucket usage snapshots (the grid recalculates these slowly).
BUCKET_POLL_INTERVAL = int(os.getenv("BUCKET_POLL_INTERVAL", str(2 * 3600)))
BUCKET_RETENTION_DAYS = int(os.getenv("BUCKET_RETENTION_DAYS", "90"))

# ── Display ───────────────────────────────────────────────────────────────────
# Physical/logical ratio shown in the tenants table (depends on your ILM policy:
# 6+3 erasure coding = 1.5, 4+2 = 1.5, 2+1 = 1.5, two replicas = 2.0, ...).
EC_OVERHEAD = float(os.getenv("EC_OVERHEAD", "1.5"))

# ── Storage / web ─────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://sgridmon:sgridmon@localhost/sgridmon"
)
# Mark the session cookie as Secure (enable when served over HTTPS).
SESSION_COOKIE_SECURE = _bool("SESSION_COOKIE_SECURE", False)

# ── Demo mode ─────────────────────────────────────────────────────────────────
# Serve a fully synthetic grid instead of talking to a real StorageGRID.
DEMO = _bool("SGRIDMON_DEMO", False)
