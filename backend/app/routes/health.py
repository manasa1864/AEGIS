"""
health.py — the /api/health endpoint.

A single GET route that returns 200 OK if the server is running.
Deployment platforms like Render use this to check the service is alive.
"""

from flask import Blueprint, jsonify

# A Blueprint is a mini-app — grouping related routes together.
# We register it in app/__init__.py.
health_bp = Blueprint('health', __name__)


@health_bp.get('/api/health')
def health_check():
    """
    GET /api/health
    Returns:  { "status": "ok", "service": "aegis-backend" }
    """
    return jsonify({'status': 'ok', 'service': 'aegis-backend'})
