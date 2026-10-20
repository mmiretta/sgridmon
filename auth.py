"""Authentication: password hashing, signed session cookies, FastAPI deps."""
import logging
import os
import secrets

from fastapi import HTTPException, Request
from itsdangerous import URLSafeSerializer, BadSignature
from passlib.context import CryptContext
from sqlalchemy import select

import config
from database import AsyncSessionLocal
from models import User

logger = logging.getLogger(__name__)

# Read once at start-up (changing it requires a restart).
SECRET_KEY = config.SECRET_KEY or secrets.token_urlsafe(48)
SESSION_COOKIE = "sgridmon_session"

# Fixed credentials used only when SGRIDMON_DEMO is enabled and no ADMIN_* is set.
DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "demo"

_serializer = URLSafeSerializer(SECRET_KEY, salt="sgridmon-auth")
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd.verify(plain, hashed)
    except Exception:
        return False


# ── Session token (signed cookie) ─────────────────────────────────────────────

def make_session_token(user_id: int, email: str, role: str) -> str:
    return _serializer.dumps({"uid": user_id, "email": email, "role": role})


def read_session_token(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return _serializer.loads(token)
    except BadSignature:
        return None


# ── FastAPI dependencies ──────────────────────────────────────────────────────

async def get_current_user(request: Request) -> User | None:
    """Returns the User or None if no valid session."""
    raw = request.cookies.get(SESSION_COOKIE)
    data = read_session_token(raw)
    if not data:
        return None
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == data["uid"]))
        user = result.scalar_one_or_none()
        if not user or not user.is_active:
            return None
        return user


async def require_user(request: Request) -> User:
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


async def require_admin(request: Request) -> User:
    user = await require_user(request)
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin role required")
    return user


# ── Bootstrap admin from environment ──────────────────────────────────────────

async def bootstrap_admin() -> None:
    """Create the first admin if no users exist.

    Uses ADMIN_EMAIL / ADMIN_PASSWORD when set (demo mode: demo@example.com / demo).
    Otherwise creates admin@example.com with a random password printed to the log.
    """
    email = os.getenv("ADMIN_EMAIL")
    password = os.getenv("ADMIN_PASSWORD")
    if config.DEMO and not (email and password):
        email, password = DEMO_EMAIL, DEMO_PASSWORD
    generated = False
    if not email or not password:
        email = email or "admin@example.com"
        password = secrets.token_urlsafe(12)
        generated = True
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).limit(1))
        if result.scalar_one_or_none():
            return  # users already exist
        admin = User(email=email, hashed_password=hash_password(password), role="admin")
        session.add(admin)
        await session.commit()
    if generated:
        logger.warning(
            "No users yet: created admin %s with password %s "
            "(sign in and change it from the account menu)", email, password)
