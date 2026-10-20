import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, Response, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select

import config
import poller
import metrics
import tenants as tenants_mod
import charts as charts_mod
import buckets as buckets_mod
import auth as auth_mod
import settings as settings_mod
from auth import (
    SESSION_COOKIE, hash_password, verify_password, make_session_token,
    get_current_user, require_user, require_admin, bootstrap_admin,
)
from database import AsyncSessionLocal, engine
from models import Base, Case, CaseNote, AlertAck, User, NodeNote

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

logger.info("Configuration file: %s", config.CONFIG_PATH)
if config.DEMO:
    logger.warning("SGRIDMON_DEMO is enabled: serving a synthetic grid, no StorageGRID is contacted")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await bootstrap_admin()
    task = asyncio.create_task(poller.poll_loop())
    task2 = asyncio.create_task(metrics.metrics_loop(poller.get_snapshot))
    task3 = asyncio.create_task(buckets_mod.poll_loop())
    yield
    task.cancel()
    task2.cancel()
    task3.cancel()


app = FastAPI(lifespan=lifespan)
app.include_router(settings_mod.router)


# ── Auth gate: every /api/* and /ws needs a valid session ────────────────────

PUBLIC_PATHS = {"/api/auth/login", "/api/auth/me", "/api/meta"}


@app.middleware("http")
async def auth_gate(request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in PUBLIC_PATHS:
        user = await get_current_user(request)
        if not user:
            return Response(
                content='{"detail":"authentication required"}',
                status_code=401,
                media_type="application/json",
            )
        request.state.user = user
    return await call_next(request)


# ── Auth endpoints ────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == body.email))
        user = result.scalar_one_or_none()
        if not user or not user.is_active or not verify_password(body.password, user.hashed_password):
            raise HTTPException(401, "invalid credentials")
        user.last_login_at = datetime.now(timezone.utc)
        await session.commit()
        token = make_session_token(user.id, user.email, user.role)
        response.set_cookie(
            SESSION_COOKIE, token,
            httponly=True, samesite="lax", secure=config.SESSION_COOKIE_SECURE,
            max_age=60 * 60 * 24 * 30,   # 30 days
            path="/",
        )
        return {"id": user.id, "email": user.email, "role": user.role}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/change-password")
async def change_password(body: ChangePasswordRequest, user: User = Depends(require_user)):
    if len(body.new_password) < 8:
        raise HTTPException(400, "new password must be at least 8 characters")
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user.id))
        u = result.scalar_one()
        if not verify_password(body.current_password, u.hashed_password):
            raise HTTPException(401, "current password incorrect")
        u.hashed_password = hash_password(body.new_password)
        await session.commit()
        return {"ok": True}


@app.post("/api/auth/logout")
async def logout(response: Response, _user: User = Depends(require_user)):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request):
    user = await get_current_user(request)
    if not user:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "id": user.id, "email": user.email, "role": user.role,
    }


@app.get("/api/meta")
async def meta():
    """Public, non-sensitive UI settings."""
    out = {"demo": config.DEMO, "ec_overhead": config.EC_OVERHEAD}
    if config.DEMO:
        out["demo_login"] = {"email": auth_mod.DEMO_EMAIL, "password": auth_mod.DEMO_PASSWORD}
    return out


# ── User management (admin-only) ──────────────────────────────────────────────

class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "viewer"


class UserUpdate(BaseModel):
    role: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None


def _user_dict(u: User) -> dict:
    return {
        "id": u.id, "email": u.email, "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
    }


@app.get("/api/users")
async def list_users(_admin: User = Depends(require_admin)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).order_by(User.created_at.asc()))
        return [_user_dict(u) for u in result.scalars().all()]


@app.post("/api/users", status_code=201)
async def create_user(body: UserCreate, _admin: User = Depends(require_admin)):
    if body.role not in ("admin", "viewer"):
        raise HTTPException(400, "role must be admin or viewer")
    async with AsyncSessionLocal() as session:
        existing = await session.execute(select(User).where(User.email == body.email))
        if existing.scalar_one_or_none():
            raise HTTPException(400, "email already exists")
        user = User(
            email=body.email, role=body.role,
            hashed_password=hash_password(body.password),
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return _user_dict(user)


@app.patch("/api/users/{user_id}")
async def update_user(user_id: int, body: UserUpdate, admin: User = Depends(require_admin)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(404, "not found")
        if body.role is not None:
            if body.role not in ("admin", "viewer"):
                raise HTTPException(400, "role must be admin or viewer")
            user.role = body.role
        if body.password:
            user.hashed_password = hash_password(body.password)
        if body.is_active is not None:
            if user.id == admin.id and not body.is_active:
                raise HTTPException(400, "cannot deactivate yourself")
            user.is_active = body.is_active
        await session.commit()
        await session.refresh(user)
        return _user_dict(user)


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, admin: User = Depends(require_admin)):
    if user_id == admin.id:
        raise HTTPException(400, "cannot delete yourself")
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if user:
            await session.delete(user)
            await session.commit()
    return {"ok": True}


# ── Grid API ──────────────────────────────────────────────────────────────────

@app.get("/api/connectivity")
async def get_connectivity():
    return metrics.get_connectivity()


@app.get("/api/traffic")
async def get_traffic():
    return metrics.get_traffic()


@app.get("/api/storage")
async def get_storage():
    return metrics.get_storage()


@app.get("/api/tenants")
async def get_tenants():
    return await asyncio.to_thread(tenants_mod.get_tenants)


@app.get("/api/tenants/history")
async def get_tenants_history(range: str = "6h"):
    return await asyncio.to_thread(tenants_mod.get_tenant_history, range)


# Per-bucket history (Phase 2 — local DB).
# range is in the same vocabulary as /api/charts: 6h / 24h / 7d / 30d / 90d
_BUCKET_RANGES = {
    "6h":  6 * 3600,
    "24h": 24 * 3600,
    "7d":  7 * 24 * 3600,
    "30d": 30 * 24 * 3600,
    "90d": 90 * 24 * 3600,
}


@app.get("/api/tenants/buckets/status")
async def get_buckets_status():
    return buckets_mod.get_status()


@app.get("/api/tenants/{tenant_id}/buckets")
async def get_tenant_buckets(tenant_id: str, range: str = "30d"):
    secs = _BUCKET_RANGES.get(range, _BUCKET_RANGES["30d"])
    return await buckets_mod.get_buckets_for_tenant(tenant_id, secs)


@app.post("/api/tenants/{tenant_id}/buckets/refresh")
async def refresh_tenant_buckets(tenant_id: str, _user=Depends(require_user)):
    return await buckets_mod.refresh_tenant_now(tenant_id)


@app.get("/api/charts")
async def get_charts(range: str = "24h"):
    return await asyncio.to_thread(charts_mod.get_charts, range)


# ── Alert acknowledgements ────────────────────────────────────────────────────

class AckCreate(BaseModel):
    alert_name: str
    note: Optional[str] = None
    acknowledged_by: Optional[str] = "admin"


def _ack_dict(a: AlertAck) -> dict:
    return {
        "id": a.id,
        "alert_name": a.alert_name,
        "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
        "acknowledged_by": a.acknowledged_by,
        "note": a.note,
    }


@app.get("/api/acks")
async def list_acks():
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(AlertAck))
        return {a.alert_name: _ack_dict(a) for a in result.scalars().all()}


@app.post("/api/acks", status_code=201)
async def acknowledge(body: AckCreate):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(AlertAck).where(AlertAck.alert_name == body.alert_name)
        )
        ack = result.scalar_one_or_none()
        if ack:
            ack.acknowledged_at = datetime.now(timezone.utc)
            ack.note = body.note
            ack.acknowledged_by = body.acknowledged_by or "admin"
        else:
            ack = AlertAck(
                alert_name=body.alert_name,
                note=body.note,
                acknowledged_by=body.acknowledged_by or "admin",
            )
            session.add(ack)
        await session.commit()
        await session.refresh(ack)
        return _ack_dict(ack)


@app.delete("/api/acks/{ack_id}")
async def unacknowledge(ack_id: int):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(AlertAck).where(AlertAck.id == ack_id))
        ack = result.scalar_one_or_none()
        if ack:
            await session.delete(ack)
            await session.commit()
    return {"ok": True}


@app.get("/api/graph")
async def get_graph():
    return poller.get_snapshot()


@app.get("/api/nodes/{node_id}/details")
async def get_node_details(node_id: str):
    snapshot = poller.get_snapshot()
    for node in snapshot.get("nodes", []):
        if node["id"] == node_id:
            return node
    return {"error": "node not found"}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    # Authenticate via session cookie (middleware doesn't intercept WebSockets)
    raw_cookie = ws.cookies.get(SESSION_COOKIE)
    data = auth_mod.read_session_token(raw_cookie)
    if not data:
        await ws.close(code=4401)
        return
    await ws.accept()
    poller.add_client(ws)
    snapshot = poller.get_snapshot()
    if snapshot:
        await ws.send_json({"type": "snapshot", "data": snapshot})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        poller.remove_client(ws)


# ── Cases API ─────────────────────────────────────────────────────────────────

class CaseCreate(BaseModel):
    node_id: str
    node_name: str
    site_name: Optional[str] = None
    case_ref: Optional[str] = None
    title: str
    description: Optional[str] = None


class CaseUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    case_ref: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None


def _case_dict(c: Case) -> dict:
    return {
        "id": c.id,
        "node_id": c.node_id,
        "node_name": c.node_name,
        "site_name": c.site_name,
        "case_ref": c.case_ref,
        "title": c.title,
        "description": c.description,
        "status": c.status,
        "opened_at": c.opened_at.isoformat() if c.opened_at else None,
        "closed_at": c.closed_at.isoformat() if c.closed_at else None,
        "notes": c.notes,
    }


@app.get("/api/cases")
async def list_cases(status: str = "open"):
    async with AsyncSessionLocal() as session:
        q = select(Case).where(Case.status == status).order_by(Case.opened_at.asc())
        result = await session.execute(q)
        return [_case_dict(c) for c in result.scalars().all()]


@app.post("/api/cases", status_code=201)
async def create_case(body: CaseCreate):
    async with AsyncSessionLocal() as session:
        case = Case(
            node_id=body.node_id,
            node_name=body.node_name,
            site_name=body.site_name,
            case_ref=body.case_ref,
            title=body.title,
            description=body.description,
        )
        session.add(case)
        await session.commit()
        await session.refresh(case)
        return _case_dict(case)


class NoteCreate(BaseModel):
    content: str
    author: Optional[str] = "admin"


def _note_dict(n: CaseNote) -> dict:
    return {
        "id": n.id,
        "case_id": n.case_id,
        "content": n.content,
        "author": n.author,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@app.get("/api/cases/{case_id}/notes")
async def get_case_notes(case_id: int):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(CaseNote).where(CaseNote.case_id == case_id).order_by(CaseNote.created_at.asc())
        )
        return [_note_dict(n) for n in result.scalars().all()]


@app.post("/api/cases/{case_id}/notes", status_code=201)
async def add_case_note(case_id: int, body: NoteCreate):
    if not body.content.strip():
        return {"error": "content required"}
    async with AsyncSessionLocal() as session:
        note = CaseNote(case_id=case_id, content=body.content.strip(), author=body.author or "admin")
        session.add(note)
        await session.commit()
        await session.refresh(note)
        return _note_dict(note)


@app.delete("/api/cases/notes/{note_id}")
async def delete_case_note(note_id: int):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(CaseNote).where(CaseNote.id == note_id))
        note = result.scalar_one_or_none()
        if note:
            await session.delete(note)
            await session.commit()
    return {"ok": True}


class NodeNoteCreate(BaseModel):
    node_name: str
    content: str
    author: Optional[str] = "admin"


def _node_note_dict(n: NodeNote) -> dict:
    return {
        "id": n.id,
        "node_id": n.node_id,
        "node_name": n.node_name,
        "content": n.content,
        "author": n.author,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@app.get("/api/nodes/{node_id}/notes")
async def get_node_notes(node_id: str):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(NodeNote).where(NodeNote.node_id == node_id).order_by(NodeNote.created_at.desc())
        )
        return [_node_note_dict(n) for n in result.scalars().all()]


@app.post("/api/nodes/{node_id}/notes", status_code=201)
async def add_node_note(node_id: str, body: NodeNoteCreate, user: User = Depends(require_user)):
    if not body.content.strip():
        raise HTTPException(400, "content required")
    async with AsyncSessionLocal() as session:
        note = NodeNote(
            node_id=node_id,
            node_name=body.node_name,
            content=body.content.strip(),
            author=user.email,
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        return _node_note_dict(note)


@app.delete("/api/nodes/notes/{note_id}")
async def delete_node_note(note_id: int, _user: User = Depends(require_user)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(NodeNote).where(NodeNote.id == note_id))
        note = result.scalar_one_or_none()
        if note:
            await session.delete(note)
            await session.commit()
    return {"ok": True}


@app.get("/api/nodes/{node_id}/cases")
async def get_node_cases(node_id: str):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Case)
            .where(Case.node_id == node_id)
            .order_by(Case.status.asc(), Case.opened_at.desc())
        )
        return [_case_dict(c) for c in result.scalars().all()]


@app.get("/api/cases/open-summary")
async def open_cases_summary():
    """Returns {node_id: count} for all nodes with open cases."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Case).where(Case.status == "open")
        )
        counts: dict[str, int] = {}
        for c in result.scalars().all():
            counts[c.node_id] = counts.get(c.node_id, 0) + 1
        return counts


@app.patch("/api/cases/{case_id}")
async def update_case(case_id: int, body: CaseUpdate):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Case).where(Case.id == case_id))
        case = result.scalar_one_or_none()
        if not case:
            return {"error": "not found"}
        if body.status is not None:
            case.status = body.status
            if body.status == "closed" and not case.closed_at:
                case.closed_at = datetime.now(timezone.utc)
        if body.notes is not None:
            case.notes = body.notes
        if body.case_ref is not None:
            case.case_ref = body.case_ref
        if body.title is not None:
            case.title = body.title
        if body.description is not None:
            case.description = body.description
        await session.commit()
        await session.refresh(case)
        return _case_dict(case)


@app.delete("/api/cases/{case_id}")
async def delete_case(case_id: int):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Case).where(Case.id == case_id))
        case = result.scalar_one_or_none()
        if case:
            await session.delete(case)
            await session.commit()
    return {"ok": True}


# ── Static files (must be last) ───────────────────────────────────────────────

from fastapi.responses import RedirectResponse


@app.get("/")
async def root(request: Request):
    user = await get_current_user(request)
    if not user:
        return RedirectResponse(url="/login.html", status_code=303)
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static", html=True), name="static")
