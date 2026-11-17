"""stream publications

Revision ID: e7f1a2b3c4d5
Revises: c2d8f4a6b1e9
Create Date: 2026-11-18 00:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

STREAM_REF_FK = "stream_refs.id"

revision: str = "e7f1a2b3c4d5"
down_revision: str | Sequence[str] | None = "c2d8f4a6b1e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the durable publication operation table and its guards."""
    op.create_table(
        "stream_publications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("operation_uuid", sa.String(length=64), nullable=False),
        sa.Column("campaign_id", sa.Integer(), nullable=False),
        sa.Column("stream_ref", sa.Integer(), nullable=False),
        sa.Column(
            "stream_ref_id",
            sa.Integer(),
            sa.ForeignKey(STREAM_REF_FK),
            nullable=False,
        ),
        sa.Column(
            "campaign_creation_operation_id",
            sa.Integer(),
            sa.ForeignKey("campaign_creation_operations.id"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("draft_version", sa.Integer(), nullable=False),
        sa.Column(
            "attempt_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("request_payload_json", sa.Text(), nullable=False),
        sa.Column("remote_baseline_before_json", sa.Text(), nullable=False),
        sa.Column("remote_baseline_after_json", sa.Text(), nullable=True),
        sa.Column("expected_intent_json", sa.Text(), nullable=False),
        sa.Column("effective_offers_json", sa.Text(), nullable=False),
        sa.Column("staged_offers_json", sa.Text(), nullable=False),
        sa.Column("error", sa.String(length=1000), nullable=True),
        sa.Column("evidence_json", sa.Text(), nullable=True),
        sa.Column("worker_token", sa.String(length=64), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation_uuid", name="uq_stream_publications_operation_uuid"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'in_progress', 'succeeded', 'failed', "
            "'ambiguous', 'abandoned')",
            name="ck_publication_status",
        ),
        sa.CheckConstraint("attempt_count >= 0", name="ck_publication_attempt_count"),
        sa.CheckConstraint("draft_version >= 0", name="ck_publication_draft_version"),
    )
    op.create_index(
        "ix_stream_publications_campaign",
        "stream_publications",
        ["campaign_id"],
        unique=False,
    )
    op.create_index(
        "ix_stream_publications_stream",
        "stream_publications",
        ["stream_ref"],
        unique=False,
    )
    op.create_index(
        "uq_stream_publications_unresolved",
        "stream_publications",
        ["stream_ref_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('pending', 'in_progress', 'ambiguous')"),
    )


def downgrade() -> None:
    """Drop the publication table and its indexes."""
    op.drop_index("uq_stream_publications_unresolved", table_name="stream_publications")
    op.drop_index("ix_stream_publications_stream", table_name="stream_publications")
    op.drop_index("ix_stream_publications_campaign", table_name="stream_publications")
    op.drop_table("stream_publications")
