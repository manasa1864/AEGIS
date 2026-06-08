"""
config.py — reads environment variables and exposes them as a Config class.

Flask reads app.config.from_object(Config) in __init__.py,
so every key here becomes available as app.config['KEY'].
"""

import os
from dotenv import load_dotenv

# Load variables from backend/.env into the process environment
load_dotenv()


class Config:
    # ── Database ──────────────────────────────────────────────────────────────
    # PostgreSQL connection string.
    # Format:  postgresql://username:password@host:port/database_name
    # Local:   postgresql://postgres:yourpassword@localhost:5432/aegis
    # Render:  the DATABASE_URL env var is set automatically when you add a DB
    SQLALCHEMY_DATABASE_URI = os.getenv(
        'DATABASE_URL',
        'postgresql://postgres:password@localhost:5432/aegis'
    )

    # Silence a SQLAlchemy deprecation warning — we don't need modification tracking
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # ── Flask ─────────────────────────────────────────────────────────────────
    # Used to sign session cookies. Must be random and secret in production.
    # Generate one:  python -c "import secrets; print(secrets.token_hex())"
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-change-in-production')

    # ── JWT ───────────────────────────────────────────────────────────────────
    # Secret used to sign JWT tokens. Reuses SECRET_KEY by default.
    # Tokens expire after 7 days — users stay logged in across sessions.
    JWT_SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-change-in-production')
    JWT_ACCESS_TOKEN_EXPIRES = 60 * 60 * 24 * 7  # 7 days in seconds

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Which frontend URLs are allowed to call this backend.
    # Add your Vercel URL here once deployed.
    FRONTEND_ORIGINS = [
        'http://localhost:5173',       # Vite dev server
        'https://*.vercel.app',        # Any Vercel preview URL
    ]
