from datetime import datetime, timezone
from sqlalchemy import Text, String, DateTime, UniqueConstraint, ForeignKey, Integer, BigInteger, Index
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Case(Base):
    __tablename__ = "cases"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    node_name: Mapped[str] = mapped_column(String(128), nullable=False)
    site_name: Mapped[str | None] = mapped_column(String(128))
    case_ref: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="viewer")  # admin | viewer
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NodeNote(Base):
    __tablename__ = "node_notes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    node_name: Mapped[str] = mapped_column(String(128), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(128), default="admin")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class CaseNote(Base):
    __tablename__ = "case_notes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    case_id: Mapped[int] = mapped_column(
        ForeignKey("cases.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(128), default="admin")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AlertAck(Base):
    __tablename__ = "alert_acks"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    alert_name: Mapped[str] = mapped_column(String(256), nullable=False, unique=True, index=True)
    acknowledged_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    acknowledged_by: Mapped[str] = mapped_column(String(128), default="admin")
    note: Mapped[str | None] = mapped_column(Text)


class BucketSnapshot(Base):
    """Per-bucket usage snapshot. Polled every ~2h from
    /grid/accounts/{tenant_id}/usage since this data is NOT in Prometheus."""
    __tablename__ = "bucket_snapshots"

    id: Mapped[int]              = mapped_column(primary_key=True, autoincrement=True)
    tenant_id: Mapped[str]       = mapped_column(String(32), nullable=False)
    tenant_name: Mapped[str]     = mapped_column(String(128), nullable=False)
    bucket_name: Mapped[str]     = mapped_column(String(255), nullable=False)
    data_bytes: Mapped[int]      = mapped_column(BigInteger, nullable=False)
    object_count: Mapped[int]    = mapped_column(BigInteger, nullable=False)
    calculation_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    __table_args__ = (
        Index("ix_bucket_tenant_bucket_time", "tenant_id", "bucket_name", "captured_at"),
    )
