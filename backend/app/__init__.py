"""
app/__init__.py — the Flask application factory.

How it works:
  1. Create the Flask app
  2. Load config (DATABASE_URL, SECRET_KEY, JWT settings)
  3. Set up CORS so the React frontend can call us
  4. Connect SQLAlchemy (ORM) and JWTManager (auth tokens)
  5. Register all route blueprints
  6. Auto-create database tables on first run
"""

from flask import Flask
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from sqlalchemy import text
from .config import Config
from .db import db


def _run_migrations(app: Flask) -> None:
    """
    Lightweight schema migrations — adds columns that were introduced after
    the initial table was created.  Each statement uses IF NOT EXISTS so it
    is safe to run on every startup.
    """
    migrations = [
        # repos — columns added after initial deploy
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS category VARCHAR(100)",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS healing_status VARCHAR(20)",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS description TEXT",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS stars INTEGER",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS forks INTEGER",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS language VARCHAR(100)",
        "ALTER TABLE repos ADD COLUMN IF NOT EXISTS open_issues INTEGER",
        # healing_events — user_id added for per-user scoping
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        # healing_events — provider (github / gitlab) for multi-platform support
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'github'",
        # healing_events — intelligence layer
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS confidence FLOAT",
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS ranked_fixes JSON",
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS postmortem TEXT",
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS recovery_time_ms INTEGER",
        "ALTER TABLE healing_events ADD COLUMN IF NOT EXISTS sources JSON",
        # pipeline_runs — user_id added for per-user scoping
        "ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
    ]
    with app.app_context():
        with db.engine.connect() as conn:
            for stmt in migrations:
                try:
                    conn.execute(text(stmt))
                except Exception as e:
                    err = str(e).lower()
                    if 'already exists' in err or 'duplicate column' in err:
                        continue  # idempotent — column/table already present
                    app.logger.error('Migration failed (%s): %s', str(e)[:120], stmt[:80])
                    raise  # schema is broken; do not start the app
            conn.commit()


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)

    # Allow the React frontend — origins are configured in Config.FRONTEND_ORIGINS
    CORS(app, resources={r'/api/*': {'origins': Config.FRONTEND_ORIGINS}})

    # Connect SQLAlchemy and JWT to this app
    db.init_app(app)
    JWTManager(app)

    # Register all route blueprints
    from .routes.health import health_bp
    from .routes.auth import auth_bp
    from .routes.repos import repos_bp
    from .routes.events import events_bp
    from .routes.runs import runs_bp
    from .routes.metrics import metrics_bp
    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(repos_bp)
    app.register_blueprint(events_bp)
    app.register_blueprint(runs_bp)
    app.register_blueprint(metrics_bp)

    # Auto-create all tables (safe to run repeatedly — skips existing tables)
    with app.app_context():
        from .models import HealingEvent, PipelineRun, User, Repo  # noqa: F401
        db.create_all()

    # Add any missing columns introduced after the initial schema was created
    _run_migrations(app)

    return app
