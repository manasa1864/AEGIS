"""
pipeline_run.py — the PipelineRun database model.

One row = one CI/CD run that Aegis has seen (success OR failure).

This is a lightweight log of every pipeline Aegis monitors.
Healing events (healing_events table) are only created when a run fails
and Aegis attempts a fix. This table tracks everything Aegis observed.
"""

from datetime import datetime
from ..db import db


class PipelineRun(db.Model):
    __tablename__ = 'pipeline_runs'

    # ── Primary key ───────────────────────────────────────────────────────────
    id = db.Column(db.Integer, primary_key=True)

    # ── Pipeline identity ─────────────────────────────────────────────────────
    pipeline_id  = db.Column(db.String(100), nullable=False)  # GitHub/GitLab run ID
    project_name = db.Column(db.String(200), nullable=False)  # "my-org/my-repo"
    branch       = db.Column(db.String(200), nullable=False)  # "main", "feature/..."
    provider     = db.Column(db.String(20),  nullable=False)  # "github" or "gitlab"

    # ── Run outcome ───────────────────────────────────────────────────────────
    status     = db.Column(db.String(30), nullable=False)  # success / failure / in_progress
    conclusion = db.Column(db.String(30))                   # failure / cancelled / timed_out / etc.

    # ── Timestamps ────────────────────────────────────────────────────────────
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        """Convert this row to a plain dict so Flask can return it as JSON."""
        return {
            'id':           self.id,
            'pipeline_id':  self.pipeline_id,
            'project_name': self.project_name,
            'branch':       self.branch,
            'provider':     self.provider,
            'status':       self.status,
            'conclusion':   self.conclusion,
            'created_at':   self.created_at.isoformat() if self.created_at else None,
        }

    def __repr__(self):
        return f'<PipelineRun id={self.id} project={self.project_name} status={self.status}>'
