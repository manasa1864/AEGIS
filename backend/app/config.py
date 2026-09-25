"""
config.py — reads environment variables and exposes them as a Config class.

Flask reads app.config.from_object(Config) in __init__.py,
so every key here becomes available as app.config['KEY'].
"""

import os
import secrets
import warnings
from dotenv import load_dotenv

# Load variables from backend/.env into the process environment
load_dotenv()


def _database_url() -> str:
    url = os.getenv('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/aegis')
    # Render/Heroku hand out "postgres://" URLs, which SQLAlchemy 1.4+ rejects.
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    return url


def _secret_key() -> str:
    key = os.getenv('SECRET_KEY')
    if key:
        return key
    # Never fall back to a well-known constant — anyone could forge JWTs with it.
    # A random per-process key is safe; tokens just stop working after a restart.
    warnings.warn('SECRET_KEY is not set — using a random key; logins will not survive a restart.')
    return secrets.token_hex(32)


class Config:
    # ── Database ──────────────────────────────────────────────────────────────
    # PostgreSQL connection string.
    # Format:  postgresql://username:password@host:port/database_name
    # Local:   postgresql://postgres:yourpassword@localhost:5432/aegis
    # Render:  the DATABASE_URL env var is set automatically when you add a DB
    SQLALCHEMY_DATABASE_URI = _database_url()

    # Silence a SQLAlchemy deprecation warning — we don't need modification tracking
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # ── Flask ─────────────────────────────────────────────────────────────────
    # Used to sign session cookies. Must be random and secret in production.
    # Generate one:  python -c "import secrets; print(secrets.token_hex())"
    SECRET_KEY = _secret_key()

    # ── JWT ───────────────────────────────────────────────────────────────────
    # Secret used to sign JWT tokens. Reuses SECRET_KEY by default.
    # Tokens expire after 7 days — users stay logged in across sessions.
    JWT_SECRET_KEY = SECRET_KEY
    JWT_ACCESS_TOKEN_EXPIRES = 60 * 60 * 24 * 7  # 7 days in seconds

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Which frontend URLs are allowed to call this backend.
    # Flask-CORS treats each entry as a regex, so escape dots and use `.*`
    # (the old glob-style 'https://*.vercel.app' is an INVALID regex and
    # silently never matched, breaking the deployed frontend).
    # FRONTEND_URL lets production point at one exact origin via env var.
    FRONTEND_ORIGINS = [
        'http://localhost:5173',                 # Vite dev server
        r'https://.*\.vercel\.app',              # Any Vercel preview/prod URL
    ]
    _extra_origin = os.getenv('FRONTEND_URL')
    if _extra_origin:
        FRONTEND_ORIGINS.append(_extra_origin)
