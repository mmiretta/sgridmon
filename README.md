# sgridmon

**A live, graph-based monitor for NetApp StorageGRID.**

sgridmon polls the StorageGRID Grid Management API and turns it into a single web page:
every site and node drawn as a live force-directed graph, coloured by health and fill
level, with inter-site traffic, S3 throughput, ILM backlog, Cassandra repair progress,
tenant and bucket growth, a hardware inventory, and a lightweight case tracker so the
operations team can attach tickets and notes to the nodes they're working on.

It is a small FastAPI + PostgreSQL app with a framework-free JavaScript front end
(using [force-graph](https://github.com/vasturiano/force-graph)). It ships with a
**demo mode** that serves a synthetic grid, so you can try it without a StorageGRID.

![Site mesh topology](docs/screenshots/01-topology.png)

*Site mesh topology (above) and site columns layout (below), which groups every node into its site.*

![Site columns](docs/screenshots/06-columns.png)

## Features

- **Live topology graph.** Sites appear as hubs showing their storage fill. Nodes show
  health, fill %, alert badges and open cases. Links between sites show the estimated
  inter-site throughput. There are four layouts (site mesh, force physics, radial,
  site columns), and node search jumps to and highlights the match.
- **Real-time updates.** A WebSocket pushes a new snapshot whenever topology, node
  health or alerts change.
- **Grid metrics panel.** S3 ingest/retrieve per site and grid-wide, ILM queue
  (client/background), and Cassandra reaper repair % per keyspace. Ranges go from
  5 minutes to 7 days, with crosshair tooltips.
- **Alerts.** Active alerts are grouped by type with severity filters, and each group
  can be acknowledged or unacknowledged (stored locally, so it doesn't touch the grid).
  An acknowledged alert no longer colours the node.
- **Node panel.** Shows alerts with recommended actions, affected services, hardware
  (model, serials, BIOS, shelves), FQDN/IP with click-to-copy, free-form node notes,
  and cases.
- **Cases.** Open a case on a node with your ticket reference, add a timeline of notes,
  close it, and browse the history. Nodes with open cases get a dashed ring.
- **Tenants.** Logical and physical usage, object counts, quota %, a 30-day growth
  sparkline, and an expandable usage history. Per-bucket history comes from periodic
  snapshots stored in the database, because StorageGRID doesn't expose bucket metrics
  in Prometheus. CSV export is included.
- **Hardware inventory.** A sortable, filterable table of every node with model,
  serials, BIOS, shelves, storage controller firmware, SANtricity OS and NVSRAM
  versions, FQDN and IP, plus CSV export. StorageGRID only exposes controller A's
  firmware; controller B is not available without SANtricity's own API.
- **Users.** Local accounts with `admin` / `viewer` roles, bcrypt-hashed passwords and
  signed session cookies. Admins manage users from the UI.

| Node panel | Alerts |
|---|---|
| ![Node panel](docs/screenshots/02-node-panel.png) | ![Alerts](docs/screenshots/03-alerts.png) |

| Tenants and buckets | Hardware inventory |
|---|---|
| ![Tenants](docs/screenshots/04-tenants.png) | ![Inventory](docs/screenshots/05-inventory.png) |

*All screenshots come from demo mode. Every name, serial number and address is synthetic.*

## Requirements

- **StorageGRID with Grid Management API v4.** sgridmon calls `/api/v4/...`, which is
  available on StorageGRID 11.8 and later. Older grids that only offer v3 are not
  supported.
- A **local grid user** that can sign in to the Grid Management API. Read-only access
  is enough, and root isn't needed. sgridmon only reads from the grid. It never
  changes grid configuration.
- Docker with Docker Compose v2, *or* Python 3.12+ and PostgreSQL 14+ (SQLite works for
  trying it out).

### API endpoints used

| Endpoint | Purpose |
|---|---|
| `POST /api/v4/authorize` | Bearer token |
| `GET /api/v4/grid/health/topology` | Sites and their nodes |
| `GET /api/v4/grid/node-health` | Node type, state, severity |
| `GET /api/v4/grid/alerts?include=active` | Active alerts |
| `GET /api/v4/grid/metric-query` | Instant Prometheus queries (fill, traffic, latency, hardware, tenants) |
| `GET /api/v4/grid/metric-query-range` | Chart history |
| `GET /api/v4/grid/accounts[/{id}[/usage]]` | Tenant names and per-bucket usage |

By default sgridmon makes a few requests every 60 seconds, plus one usage call per
tenant every 2 hours. You can tune this with the `*_INTERVAL` settings.

## Quick start (Docker)

```bash
git clone https://github.com/mmiretta/sgridmon.git
cd sgridmon
cp .env.example .env         # optional: database password, port, first admin
docker compose up -d --build
```

This starts sgridmon and the bundled PostgreSQL (`db` service, recommended). No `.env`
is required. Open <http://localhost:8090> and sign in:

- with `ADMIN_EMAIL` / `ADMIN_PASSWORD` if you set them in `.env`, or
- with `admin@example.com` and the random password printed in the log
  (`docker compose logs app | grep "created admin"`).

That first admin is created only when the user table is empty. Then click the
**⚙ Settings** button, enter the StorageGRID URL, user and password, use
**Test StorageGRID** and **Save**. The first snapshot appears after one poll cycle.

The published port listens on `127.0.0.1` by default (`SGRIDMON_BIND`, `SGRIDMON_PORT`).
To expose sgridmon to other people, put it behind a reverse proxy that terminates TLS
(Caddy, nginx, Traefik, ...) and enable *Secure session cookie*. The proxy must
forward WebSocket upgrades on `/ws`.

## Demo mode

Demo mode needs no StorageGRID. Run:

```bash
SGRIDMON_DEMO=1 docker compose up -d --build
# open http://localhost:8090 and sign in with demo@example.com / demo
```

Or without Docker:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SGRIDMON_DEMO=1 DATABASE_URL=sqlite+aiosqlite:///./demo.db uvicorn main:app --port 8090
```

Demo mode serves a synthetic grid: three sites (DC1, DC2, DC3) with 30 nodes,
fill levels from about 55% to 93%, eight active alerts (including a disconnected node),
14 tenants with 30 days of bucket history, and daily traffic curves. The demo data
goes through the same parsing code as a real grid, so it also works as a smoke test.
The top bar shows a **DEMO** badge, and the login page pre-fills the demo
credentials. If you set `ADMIN_EMAIL` / `ADMIN_PASSWORD`, those are used instead.

Stop it with `docker compose down` (add `-v` to delete the demo database).

## Configuration

Settings are edited from the web UI: **⚙ Settings → Configuration** (admin users
only). They are stored in a plain `KEY=value` file:

- in Docker: `/app/config/sgridmon.env`, on the named volume `config` (see
  `docker-compose.yml`; a bind mount such as `./config:/app/config` works too, after
  `chown 10001` on the directory),
- without Docker: `./config/sgridmon.env`, or the path in `SGRIDMON_CONFIG`.

Precedence is **built-in defaults < environment variables < config file**. On the first
start, if the file does not exist, it is created from the current effective values, so
an existing `.env`-based install carries over (a `SECRET_KEY` is generated if none was
set). The file is written atomically with mode `600`. You can also edit it by hand and
restart the container.

StorageGRID, polling and display settings are applied immediately when saved. Settings
marked **restart** (database, session key, secure cookie, demo mode) are stored and take
effect after `docker compose restart app`. Passwords and keys are never sent back to the
browser; leave a password field empty to keep the current value.

**Database.** By default sgridmon uses the bundled PostgreSQL container (`db`), and
Compose passes its URL in `DATABASE_URL`. To use an existing server instead, choose
*External PostgreSQL* in Settings, fill in host, port, database, user and password, use
**Test database**, save and restart. Switching back to *Bundled PostgreSQL* removes the
override. Data is not copied between databases.

| Setting | Default | Description |
|---|---|---|
| `SGRID_URL` | `https://admin01.grid.example.com` | Admin Node base URL. Node FQDNs are built as `<node>.<domain of this URL>`. |
| `SGRID_USER` / `SGRID_PASS` | `sgridmon` / *(empty)* | Grid user used by sgridmon |
| `SGRID_API_VERSION` | `4` | Grid Management API version |
| `SGRID_VERIFY_TLS` | `true` | Verify the Admin Node certificate. Set to `false` for self-signed certificates (legacy TLS is then tolerated too). |
| `SGRID_CA_BUNDLE` | *(empty)* | CA bundle path, used when verifying TLS |
| `SGRID_PROXY` | *(empty)* | HTTP(S) proxy for StorageGRID calls only |
| `POLL_INTERVAL` | `60` | Seconds between topology/health/alerts polls |
| `METRICS_INTERVAL` | `60` | Seconds between traffic/storage/latency polls |
| `BUCKET_POLL_INTERVAL` | `7200` | Seconds between per-bucket usage snapshots |
| `BUCKET_RETENTION_DAYS` | `90` | How long bucket snapshots are kept |
| `EC_OVERHEAD` | `1.5` | Physical/logical ratio shown in the tenants table (depends on your ILM policy) |
| `DATABASE_URL` | bundled `db` service | SQLAlchemy async URL (`sqlite+aiosqlite:///./file.db` also works). Restart. |
| `SECRET_KEY` | *(generated)* | Signs session cookies. Restart. |
| `SESSION_COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS. Restart. |
| `SGRIDMON_DEMO` | `0` | `1` serves the synthetic demo grid. Restart. |

These are read by Docker Compose from `.env` (see [`.env.example`](.env.example)) and are
not part of the config file:

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `sgridmon` | Password for the bundled PostgreSQL |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | *(generated)* | First admin, created when there are no users |
| `SGRIDMON_BIND` / `SGRIDMON_PORT` | `127.0.0.1` / `8090` | Published address and port |

## How it works

```
StorageGRID Admin Node ──(REST + PromQL, API v4)──► sgridmon (FastAPI)
                                                     ├─ poller.py   topology/health/alerts → snapshot → WebSocket
                                                     ├─ metrics.py  traffic, storage fill, inter-site latency
                                                     ├─ charts.py   range queries for the metrics panel (60 s cache)
                                                     ├─ tenants.py  tenant usage + history (60 s cache)
                                                     ├─ buckets.py  per-bucket snapshots → PostgreSQL
                                                     ├─ settings.py configuration file editor (admin API)
                                                     └─ main.py     REST API, auth, cases, notes, acks, static UI
Browser ◄──(HTTP + WebSocket)── static/ (index.html, app.js, style.css)
```

Notes on the numbers:

- **Fill %** uses the same formula as Grid Manager: `data / (data + usable)`.
- **Inter-site throughput** comes from the grid-network (`eth0`) totals of each site.
  With exactly three sites the per-pair flows are solved as a linear system. With any
  other number of sites it is an approximation.
- **Client traffic** under each site hub is the client network (`eth2`). If your
  appliances use a different interface layout, adjust the queries in `metrics.py`.
- **Tenant usage** uses `max by(tenant_id)` because the metric is replicated on every
  Admin Node.

## Development

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SGRIDMON_DEMO=1 DATABASE_URL=sqlite+aiosqlite:///./dev.db uvicorn main:app --reload --port 8090
```

The front end is plain JavaScript with no build step. Edit the files in `static/` and
reload the page.

## Disclaimer

sgridmon is an independent open-source project. It is **not affiliated with, endorsed
by, or supported by NetApp, Inc.** NetApp and StorageGRID are trademarks of NetApp, Inc.
The software is provided as is, without warranty of any kind. Test it in your own
environment before relying on it.

## License

[MIT](LICENSE) © Mariano Miretta
