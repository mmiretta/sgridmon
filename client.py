"""Minimal client for the StorageGRID Grid Management API (v4)."""
import logging
import ssl
import threading

import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

import config

logger = logging.getLogger(__name__)


class _LegacyTLSAdapter(HTTPAdapter):
    """HTTPAdapter for unverified connections that also tolerates older TLS
    versions and legacy cipher suites (common on long-lived appliances)."""

    @staticmethod
    def _ctx():
        ctx = create_urllib3_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)
        return ctx

    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = self._ctx()
        super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, proxy, **proxy_kwargs):
        proxy_kwargs["ssl_context"] = self._ctx()
        return super().proxy_manager_for(proxy, **proxy_kwargs)


class StorageGridClient:
    def __init__(self, base_url: str, username: str, password: str, proxy: str = "",
                 verify_tls: bool = True, ca_bundle: str = "", api_version: str = "4"):
        self.base_url = base_url.rstrip("/")
        self.api_prefix = f"/api/v{api_version}"
        self.username = username
        self.password = password
        self.token: str = ""

        self.session = requests.Session()
        # Ignore HTTP(S)_PROXY from the environment; only SGRID_PROXY applies.
        self.session.trust_env = False
        if verify_tls:
            self.session.verify = ca_bundle or True
        else:
            urllib3.disable_warnings()
            self.session.verify = False
            adapter = _LegacyTLSAdapter()
            self.session.mount("https://", adapter)
            self.session.mount("http://", adapter)
        if proxy:
            self.session.proxies = {"http": proxy, "https": proxy}

    def _url(self, path: str) -> str:
        return self.base_url + self.api_prefix + path

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def authenticate(self) -> None:
        resp = self.session.post(
            self._url("/authorize"),
            json={"username": self.username, "password": self.password,
                  "cookie": False, "csrfToken": False},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        token = (data.get("data") or data.get("token") or
                 data.get("bearerToken") or data.get("access_token"))
        if not isinstance(token, str):
            raise ValueError("Unexpected response from /authorize (no token)")
        self.token = token
        logger.info("Authenticated to StorageGRID at %s", self.base_url)

    def get_raw(self, path: str, params: dict | None = None, timeout: int = 20) -> requests.Response:
        """GET an API path (relative to /api/vN), re-authenticating once on 401."""
        if not self.token:
            self.authenticate()
        resp = self.session.get(self._url(path), headers=self._headers(),
                                params=params, timeout=timeout)
        if resp.status_code == 401:
            self.token = ""
            self.authenticate()
            resp = self.session.get(self._url(path), headers=self._headers(),
                                    params=params, timeout=timeout)
        return resp

    def _get(self, path: str) -> dict:
        resp = self.get_raw(path)
        resp.raise_for_status()
        return resp.json()

    def get_health(self) -> dict:
        return self._get("/grid/health")

    def get_health_topology(self) -> dict:
        return self._get("/grid/health/topology")

    def get_node_health(self) -> dict:
        return self._get("/grid/node-health")

    def get_alerts(self) -> dict:
        return self._get("/grid/alerts?include=active")

    def query_metrics(self, promql: str, timeout: int = 10) -> list[dict]:
        """Instant Prometheus query via the StorageGRID metrics API."""
        resp = self.get_raw("/grid/metric-query", params={"query": promql}, timeout=timeout)
        resp.raise_for_status()
        return resp.json().get("data", {}).get("result", [])

    def query_range(self, promql: str, start: int, end: int, step: int,
                    timeout: int = 20) -> list[dict]:
        """Range Prometheus query. Returns [] (and logs) on non-200 responses."""
        resp = self.get_raw(
            "/grid/metric-query-range",
            params={"query": promql, "start": str(start), "end": str(end), "step": str(step)},
            timeout=timeout,
        )
        if resp.status_code != 200:
            logger.warning("range query failed: %s %s", resp.status_code, promql[:60])
            return []
        return resp.json().get("data", {}).get("result", [])


def make_client(**overrides):
    """Return a new API client: the real one, or the synthetic one in demo mode.

    Keyword overrides (base_url, username, ...) replace the configured values;
    used to test unsaved settings.
    """
    if config.DEMO:
        import demo
        return demo.DemoClient()
    kwargs = dict(
        base_url=config.SGRID_URL,
        username=config.SGRID_USER,
        password=config.SGRID_PASS,
        proxy=config.SGRID_PROXY,
        verify_tls=config.SGRID_VERIFY_TLS,
        ca_bundle=config.SGRID_CA_BUNDLE,
        api_version=config.SGRID_API_VERSION,
    )
    kwargs.update(overrides)
    return StorageGridClient(**kwargs)


# ── Shared client registry ────────────────────────────────────────────────────
# Each background module keeps its own client (separate HTTP sessions), cached
# here so that a configuration change can drop them all at once.

_registry: dict[str, "StorageGridClient"] = {}
_registry_lock = threading.Lock()


def get_client(name: str):
    """Cached client for a module; rebuilt after reset_clients()."""
    with _registry_lock:
        c = _registry.get(name)
        if c is None:
            c = _registry[name] = make_client()
        return c


def reset_clients() -> None:
    """Forget every cached client (called after the settings change)."""
    with _registry_lock:
        _registry.clear()
