from datetime import datetime
from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..models.healing_event import HealingEvent

metrics_bp = Blueprint('metrics', __name__)


@metrics_bp.get('/api/metrics')
@jwt_required()
def get_metrics():
    """GET /api/metrics — aggregated healing statistics for the current user."""
    user_id = int(get_jwt_identity())
    events = HealingEvent.query.filter_by(user_id=user_id).all()

    total   = len(events)
    healed  = sum(1 for e in events if e.status == 'healed')
    failed  = sum(1 for e in events if e.status == 'failed')
    healing = sum(1 for e in events if e.status == 'healing')

    resolved = healed + failed
    success_rate = round((healed / resolved) * 100, 1) if resolved > 0 else 0

    recovery_times = [e.recovery_time_ms for e in events if e.recovery_time_ms and e.status == 'healed']
    avg_recovery_ms = int(sum(recovery_times) / len(recovery_times)) if recovery_times else 0

    confidence_scores = [e.confidence for e in events if e.confidence is not None]
    avg_confidence = min(100.0, round(sum(confidence_scores) / len(confidence_scores), 1)) if confidence_scores else None

    by_provider: dict = {}
    for e in events:
        by_provider[e.provider] = by_provider.get(e.provider, 0) + 1

    by_severity: dict = {}
    for e in events:
        if e.severity:
            by_severity[e.severity] = by_severity.get(e.severity, 0) + 1

    by_project: dict = {}
    for e in events:
        key = e.project_name  # full "owner/repo" — prevents merging repos from different owners
        if key not in by_project:
            by_project[key] = {'healed': 0, 'failed': 0, 'healing': 0, 'total': 0}
        by_project[key]['total'] += 1
        if e.status == 'healed':
            by_project[key]['healed'] += 1
        elif e.status == 'failed':
            by_project[key]['failed'] += 1
        elif e.status == 'healing':
            by_project[key]['healing'] += 1

    recent = sorted(events, key=lambda e: e.created_at or datetime.min, reverse=True)[:10]

    return jsonify({
        'total':           total,
        'healed':          healed,
        'failed':          failed,
        'healing':         healing,
        'success_rate':    success_rate,
        'avg_recovery_ms': avg_recovery_ms,
        'avg_confidence':  avg_confidence,
        'by_provider':     by_provider,
        'by_severity':     by_severity,
        'by_project':      by_project,
        'recent':          [e.to_dict() for e in recent],
    })
