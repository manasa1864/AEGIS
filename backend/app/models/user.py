"""
user.py — the User database model.

One row = one registered Aegis user.
Passwords are NEVER stored in plain text — only a bcrypt hash.
"""

from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from ..db import db


class User(db.Model):
    __tablename__ = 'users'

    id            = db.Column(db.Integer, primary_key=True)
    name          = db.Column(db.String(200))
    email         = db.Column(db.String(200), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    # One user → many repos (cascade delete removes repos when user is deleted)
    repos = db.relationship('Repo', backref='user', lazy=True, cascade='all, delete-orphan')

    def set_password(self, password: str):
        """Hash and store a password."""
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        """Return True if the given password matches the stored hash."""
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            'id':         self.id,
            'name':       self.name,
            'email':      self.email,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }

    def __repr__(self):
        return f'<User id={self.id} email={self.email}>'
