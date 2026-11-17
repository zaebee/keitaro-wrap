"""draft version counter

Revision ID: c2d8f4a6b1e9
Revises: b4e7c9a1d2f6
Create Date: 2026-11-17 23:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c2d8f4a6b1e9"
down_revision: str | Sequence[str] | None = "b4e7c9a1d2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Track the highest draft version used for a stream."""
    with op.batch_alter_table("stream_refs") as batch:
        batch.add_column(
            sa.Column(
                "draft_version_counter",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    """Remove the monotonic draft version counter."""
    with op.batch_alter_table("stream_refs") as batch:
        batch.drop_column("draft_version_counter")
