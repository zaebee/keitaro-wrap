"""fetch reconciliation persistence

Revision ID: f4a1c8e2b9d7
Revises: c7f4a9b1e2d3
Create Date: 2026-11-17 22:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

STREAM_REF_FK = "stream_refs.id"

revision: str = "f4a1c8e2b9d7"
down_revision: str | Sequence[str] | None = "c7f4a9b1e2d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create stream reference, remote cache, binding and draft tables."""
    op.create_table(
        "stream_refs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("campaign_id", sa.Integer(), nullable=False),
        sa.Column("keitaro_stream_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("schema", sa.String(length=40), nullable=False),
        sa.Column("comments", sa.String(length=1000), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "campaign_id", "keitaro_stream_id", name="uq_stream_refs_campaign_stream"
        ),
    )
    op.create_index(
        "ix_stream_refs_campaign_id", "stream_refs", ["campaign_id"], unique=False
    )

    op.create_table(
        "remote_offer_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "stream_ref_id",
            sa.Integer(),
            sa.ForeignKey(STREAM_REF_FK),
            nullable=False,
        ),
        sa.Column("offers_json", sa.Text(), nullable=False),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("stream_ref_id", name="uq_remote_offer_snapshots_stream"),
    )

    op.create_table(
        "stream_offer_bindings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "stream_ref_id",
            sa.Integer(),
            sa.ForeignKey(STREAM_REF_FK),
            nullable=False,
        ),
        sa.Column("offer_id", sa.Integer(), nullable=False),
        sa.Column("lifecycle", sa.String(length=10), nullable=False),
        sa.Column(
            "is_pinned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("last_remote_share", sa.Integer(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("reactivated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "stream_ref_id", "offer_id", name="uq_stream_offer_bindings_pair"
        ),
        sa.CheckConstraint(
            "lifecycle IN ('ACTIVE', 'ARCHIVED')", name="ck_binding_lifecycle"
        ),
        sa.CheckConstraint(
            "last_remote_share IS NULL OR (last_remote_share BETWEEN 0 AND 100)",
            name="ck_binding_share_range",
        ),
    )
    op.create_index(
        "ix_stream_offer_bindings_lifecycle",
        "stream_offer_bindings",
        ["stream_ref_id", "lifecycle"],
        unique=False,
    )

    op.create_table(
        "stream_drafts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "stream_ref_id",
            sa.Integer(),
            sa.ForeignKey(STREAM_REF_FK),
            nullable=False,
        ),
        sa.Column("baseline_snapshot_json", sa.Text(), nullable=True),
        sa.Column("baseline_captured_at", sa.DateTime(), nullable=True),
        sa.Column("staged_changes_json", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_dirty", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_stale", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("conflict_details_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("stream_ref_id", name="uq_stream_drafts_stream"),
    )


def downgrade() -> None:
    """Drop Fetch reconciliation tables in reverse dependency order."""
    op.drop_table("stream_drafts")
    op.drop_index(
        "ix_stream_offer_bindings_lifecycle", table_name="stream_offer_bindings"
    )
    op.drop_table("stream_offer_bindings")
    op.drop_table("remote_offer_snapshots")
    op.drop_index("ix_stream_refs_campaign_id", table_name="stream_refs")
    op.drop_table("stream_refs")
