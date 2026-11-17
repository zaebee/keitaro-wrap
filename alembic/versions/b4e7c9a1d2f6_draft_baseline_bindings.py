"""draft baseline bindings

Revision ID: b4e7c9a1d2f6
Revises: f4a1c8e2b9d7
Create Date: 2026-11-17 22:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b4e7c9a1d2f6"
down_revision: str | Sequence[str] | None = "f4a1c8e2b9d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Capture immutable committed lifecycle/pin state with each draft."""
    with op.batch_alter_table("stream_drafts") as batch:
        batch.add_column(sa.Column("baseline_bindings_json", sa.Text(), nullable=True))


def downgrade() -> None:
    """Remove the immutable committed-state baseline column."""
    with op.batch_alter_table("stream_drafts") as batch:
        batch.drop_column("baseline_bindings_json")
