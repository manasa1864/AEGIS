"""
events.py — CRUD routes for healing events.

Endpoints:
  GET  /api/events             → list all healing events (newest first)
  POST /api/events             → create a new healing event
  GET  /api/events/<id>        → get one healing event by ID
  PATCH /api/events/<id>       → update a healing event (e.g. status → "healed")

The React frontend calls these routes to save and retrieve healing history.
"""

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..db import db
from ..models.healing_event import HealingEvent

events_bp = Blueprint('events', __name__)


# ── LIST ──────────────────────────────────────────────────────────────────────

@events_bp.get('/api/events')
@jwt_required()
def list_events():
    """
    GET /api/events
    Returns all healing events, newest first.

    Optional query parameters:
      ?project=my-repo   → filter by project name (partial match)
      ?status=healed     → filter by status: healing | healed | failed
      ?provider=github   → filter by provider: github | gitlab

    Example: GET /api/events?project=aegis&status=healed
    """
    user_id = int(get_jwt_identity())
    query = HealingEvent.query.filter_by(user_id=user_id)

    project  = request.args.get('project')
    status   = request.args.get('status')
    provider = request.args.get('provider')

    if project:
        query = query.filter(HealingEvent.project_name == project)
    if status:
        query = query.filter_by(status=status)
    if provider:
        query = query.filter_by(provider=provider)

    events = query.order_by(HealingEvent.created_at.desc()).all()
    return jsonify([e.to_dict() for e in events])


# ── CREATE ────────────────────────────────────────────────────────────────────

@events_bp.post('/api/events')
@jwt_required()
def create_event():
    """
    POST /api/events
    Creates a new healing event in the database.

    Request body (JSON):
    {
      "pipeline_id":    "123456",
      "project_name":   "my-org/my-repo",
      "branch":         "main",
      "provider":       "github",          (optional, default "github")
      "failed_stage":   "test",            (optional)
      "root_cause":     "Dependency...",   (optional — filled in by the AI agent)
      "severity":       "high",            (optional)
      "auto_healable":  true,              (optional)
      "fix_steps":      ["step1", ...],    (optional)
      "estimated_time": "5–10 minutes",    (optional)
      "status":         "healing"          (optional, default "healing")
    }

    Returns the created event with its database ID (HTTP 201 Created).
    """
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    # These three fields are required
    required = ['pipeline_id', 'project_name', 'branch']
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({'error': f'Missing required fields: {missing}'}), 400

    user_id = int(get_jwt_identity())
    event = HealingEvent(
        user_id        = user_id,
        pipeline_id    = data['pipeline_id'],
        project_name   = data['project_name'],
        branch         = data['branch'],
        provider       = data.get('provider', 'github'),
        failed_stage   = data.get('failed_stage'),
        root_cause     = data.get('root_cause'),
        severity       = data.get('severity'),
        auto_healable  = data.get('auto_healable', False),
        fix_steps      = data.get('fix_steps', []),
        estimated_time = data.get('estimated_time'),
        status         = data.get('status', 'healing'),
    )

    db.session.add(event)
    db.session.commit()

    return jsonify(event.to_dict()), 201  # 201 = Created


# ── READ ONE ──────────────────────────────────────────────────────────────────

@events_bp.get('/api/events/<int:event_id>')
@jwt_required()
def get_event(event_id: int):
    """
    GET /api/events/<id>
    Returns one healing event by its database ID.
    Returns 404 if it doesn't exist or belongs to another user.
    """
    user_id = int(get_jwt_identity())
    event = db.session.get(HealingEvent, event_id)
    if not event or event.user_id != user_id:
        return jsonify({'error': 'Event not found'}), 404
    return jsonify(event.to_dict())


# ── UPDATE ────────────────────────────────────────────────────────────────────

@events_bp.patch('/api/events/<int:event_id>')
@jwt_required()
def update_event(event_id: int):
    """
    PATCH /api/events/<id>
    Updates a healing event — typically to change its status after healing completes.

    Only these fields can be updated (others are ignored for safety):
      status, root_cause, severity, auto_healable, fix_steps, estimated_time,
      confidence, ranked_fixes, postmortem, recovery_time_ms, sources
    """
    user_id = int(get_jwt_identity())
    event = db.session.get(HealingEvent, event_id)
    if not event or event.user_id != user_id:
        return jsonify({'error': 'Event not found'}), 404

    data = request.get_json() or {}

    updatable_fields = [
        'status', 'root_cause', 'severity', 'auto_healable', 'fix_steps', 'estimated_time',
        'confidence', 'ranked_fixes', 'postmortem', 'recovery_time_ms', 'sources',
    ]
    for field in updatable_fields:
        if field in data:
            setattr(event, field, data[field])

    db.session.commit()
    return jsonify(event.to_dict())
