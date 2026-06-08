from datetime import datetime
from ..db import db


class HealingEvent(db.Model):
    __tablename__ = 'healing_events'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)

    pipeline_id  = db.Column(db.String(100), nullable=False)
    project_name = db.Column(db.String(200), nullable=False)
    branch       = db.Column(db.String(200), nullable=False)
    provider     = db.Column(db.String(20),  nullable=False, default='github')
    failed_stage = db.Column(db.String(200))

    root_cause     = db.Column(db.Text)
    severity       = db.Column(db.String(20))
    auto_healable  = db.Column(db.Boolean, default=False)
    fix_steps      = db.Column(db.JSON)
    estimated_time = db.Column(db.String(50))

    status = db.Column(db.String(20), default='healing')

    # intelligence layer — added for confidence-based healing + postmortems
    confidence       = db.Column(db.Float)    # AI confidence score 0–100
    ranked_fixes     = db.Column(db.JSON)     # [{description, confidence, risk}]
    postmortem       = db.Column(db.Text)     # AI-generated postmortem markdown
    recovery_time_ms = db.Column(db.Integer)  # ms from detection to resolution
    sources          = db.Column(db.JSON)     # [{title, url}] grounding sources from web search

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id':               self.id,
            'pipeline_id':      self.pipeline_id,
            'project_name':     self.project_name,
            'branch':           self.branch,
            'provider':         self.provider,
            'failed_stage':     self.failed_stage,
            'root_cause':       self.root_cause,
            'severity':         self.severity,
            'auto_healable':    self.auto_healable,
            'fix_steps':        self.fix_steps or [],
            'estimated_time':   self.estimated_time,
            'status':           self.status,
            'confidence':       self.confidence,
            'ranked_fixes':     self.ranked_fixes or [],
            'postmortem':       self.postmortem,
            'recovery_time_ms': self.recovery_time_ms,
            'sources':          self.sources or [],
            'created_at':       self.created_at.isoformat() if self.created_at else None,
        }

    def __repr__(self):
        return f'<HealingEvent id={self.id} project={self.project_name} status={self.status}>'
