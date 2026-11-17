"""campaign creation operations

Revision ID: c7f4a9b1e2d3
Revises: 5854b8527d58
Create Date: 2026-11-17 20:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c7f4a9b1e2d3"
down_revision: str | Sequence[str] | None = "5854b8527d58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the durable campaign creation operation table."""
    op.create_table(
        "campaign_creation_operations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("operation_uuid", sa.String(length=64), nullable=False),
        sa.Column("alias", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("country_code", sa.String(length=2), nullable=False),
        sa.Column("offer_id", sa.Integer(), nullable=False),
        sa.Column("keitaro_campaign_id", sa.Integer(), nullable=True),
        sa.Column("flow_country_id", sa.Integer(), nullable=True),
        sa.Column("flow_offer_id", sa.Integer(), nullable=True),
        sa.Column("domain_id", sa.Integer(), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("traffic_source_id", sa.Integer(), nullable=False),
        sa.Column("redirect_url", sa.String(length=2048), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("error_message", sa.String(length=1000), nullable=True),
        sa.Column("campaign_step", sa.String(length=20), nullable=False),
        sa.Column("country_flow_step", sa.String(length=20), nullable=False),
        sa.Column("offer_flow_step", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("alias"),
        sa.UniqueConstraint("operation_uuid"),
    )


def downgrade() -> None:
    """Drop the campaign creation operation table."""
    op.drop_table("campaign_creation_operations")
