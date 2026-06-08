"""
db.py — creates the single shared SQLAlchemy instance.

Why a separate file?
  Models import `db` from here to define their columns.
  The app factory (app/__init__.py) calls db.init_app(app) to connect it.
  This avoids a circular import between models and the app factory.
"""

from flask_sqlalchemy import SQLAlchemy

# One shared db object — imported everywhere that needs database access
db = SQLAlchemy()
