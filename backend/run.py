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

from app import create_app

app = create_app()

if __name__ == '__main__':
    # debug=True → auto-reloads when you save a file (dev only)
    # port=5000  → http://localhost:5000
    app.run(debug=True, port=5000)
