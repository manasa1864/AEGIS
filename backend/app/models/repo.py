"""
repo.py — the Repo database model.

One row = one repository a user has added to their Aegis dashboard.
Linked to the User table via user_id (foreign key).
"""

from datetime import datetime
from ..db import db


class Repo(db.Model):
    __tablename__ = 'repos'

    id          = db.Column(db.Integer, primary_key=True)
    user_id     = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)

    # ── Repo identity ─────────────────────────────────────────────────────────
    name        = db.Column(db.String(200), nullable=False)   # display name, e.g. "my-repo"
    owner       = db.Column(db.String(200))                   # GitHub/GitLab namespace
    repo_name   = db.Column(db.String(200))                   # slug, e.g. "my-repo"
    platform    = db.Column(db.String(20), default='github')  # 'github' or 'gitlab'
    github_url  = db.Column(db.String(500))                   # full URL
    branch      = db.Column(db.String(200), default='main')   # default branch

    # ── Aegis state ───────────────────────────────────────────────────────────
    error_type     = db.Column(db.String(100), default='PENDING_SCAN')
    severity       = db.Column(db.String(20),  default='medium')
    category       = db.Column(db.String(100))   # user-defined folder label, e.g. "Backend"
    healing_status = db.Column(db.String(20))    # HIGH | MEDIUM | NO_ERROR (set after healing)

    # ── Repo metadata (fetched from GitHub/GitLab API) ────────────────────────
    stars       = db.Column(db.Integer)
    forks       = db.Column(db.Integer)
    language    = db.Column(db.String(100))
    open_issues = db.Column(db.Integer)
    description = db.Column(db.Text)

    created_at  = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        """
        Returns keys that match the frontend's Project interface exactly,
        so the React dashboard can use the response without any mapping.
        """
        return {
            'id':            str(self.id),
            'name':          self.name,
            'owner':         self.owner,
            'repoName':      self.repo_name,
            'platform':      self.platform,
            'githubUrl':     self.github_url,
            'repo':          self.branch,
            'errorType':     self.error_type,
            'severity':      self.severity,
            'category':      self.category,
            'healingStatus': self.healing_status,
            'stars':         self.stars,
            'forks':         self.forks,
            'language':      self.language,
            'openIssues':    self.open_issues,
            'description':   self.description,
        }

    def __repr__(self):
        return f'<Repo id={self.id} name={self.name} user_id={self.user_id}>'
