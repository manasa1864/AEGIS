"""
run.py — entry point to start the Flask development server.

Usage:
  cd backend
  python run.py

The server starts at http://localhost:5000

Endpoints you can test in the browser or with curl:
  GET  http://localhost:5000/api/health
  GET  http://localhost:5000/api/events
  GET  http://localhost:5000/api/runs

For production (Render), gunicorn uses the Procfile instead of this file.
"""

import os

from app import create_app

app = create_app()

if __name__ == '__main__':
    # Debug mode (auto-reload + interactive debugger) is opt-out via FLASK_DEBUG=0.
    # The Werkzeug debugger allows code execution, so never expose it publicly.
    # port=5000  → http://localhost:5000
    debug = os.getenv('FLASK_DEBUG', '1') not in ('0', 'false', 'False')
    app.run(debug=debug, port=5000)
