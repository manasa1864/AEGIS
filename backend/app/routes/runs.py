"""
runs.py — routes for pipeline run records.

Endpoints:
  GET  /api/runs          → list all pipeline runs (newest first)
  POST /api/runs          → log a new pipeline run
  GET  /api/runs/<id>     → get one run by ID

The frontend calls POST /api/runs when it detects any pipeline run
(success or failure), giving us a full history of all observed runs.
"""

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..db import db
from ..models.pipeline_run import PipelineRun

runs_bp = Blueprint('runs', __name__)


# ── LIST ──────────────────────────────────────────────────────────────────────

@runs_bp.get('/api/runs')
@jwt_required()
def list_runs():
    """
    GET /api/runs
    Returns the current user's pipeline runs, newest first.

    Optional query parameters:
      ?project=my-repo    → filter by project name
      ?provider=gitlab    → filter by provider
      ?status=failure     → filter by status
    """
    user_id = int(get_jwt_identity())
    query = PipelineRun.query.filter_by(user_id=user_id)

    project  = request.args.get('project')
    provider = request.args.get('provider')
    status   = request.args.get('status')

    if project:
        query = query.filter(PipelineRun.project_name == project)
    if provider:
        query = query.filter_by(provider=provider)
    if status:
        query = query.filter_by(status=status)

    runs = query.order_by(PipelineRun.created_at.desc()).all()
    return jsonify([r.to_dict() for r in runs])


# ── CREATE ────────────────────────────────────────────────────────────────────

@runs_bp.post('/api/runs')
@jwt_required()
def create_run():
    """
    POST /api/runs
    Logs a new pipeline run.

    Request body (JSON):
    {
      "pipeline_id":   "7890",
      "project_name":  "my-org/my-repo",
      "branch":        "main",
      "provider":      "github",
      "status":        "failure",
      "conclusion":    "failure"    (optional — GitHub-specific field)
    }
    """
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    required = ['pipeline_id', 'project_name', 'branch', 'provider', 'status']
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({'error': f'Missing required fields: {missing}'}), 400

    run = PipelineRun(
        user_id      = int(get_jwt_identity()),
        pipeline_id  = data['pipeline_id'],
        project_name = data['project_name'],
        branch       = data['branch'],
        provider     = data['provider'],
        status       = data['status'],
        conclusion   = data.get('conclusion'),
    )

    db.session.add(run)
    db.session.commit()

    return jsonify(run.to_dict()), 201


# ── READ ONE ──────────────────────────────────────────────────────────────────

@runs_bp.get('/api/runs/<int:run_id>')
@jwt_required()
def get_run(run_id: int):
    """
    GET /api/runs/<id>
    Returns one pipeline run by its database ID.
    """
    user_id = int(get_jwt_identity())
    run = db.session.get(PipelineRun, run_id)
    if not run or run.user_id != user_id:
        return jsonify({'error': 'Run not found'}), 404
    return jsonify(run.to_dict())
