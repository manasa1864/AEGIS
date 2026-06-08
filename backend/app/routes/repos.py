"""
repos.py — CRUD routes for user-owned repositories.

All routes require a valid JWT token (Authorization: Bearer <token>).
Each user only sees and manages their own repos.

Endpoints:
  GET    /api/repos         → list all repos for the logged-in user
  POST   /api/repos         → add a new repo
  DELETE /api/repos/<id>    → remove a repo
"""

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..db import db
from ..models.repo import Repo

repos_bp = Blueprint('repos', __name__)


@repos_bp.get('/api/repos')
@jwt_required()
def list_repos():
    """
    GET /api/repos
    Returns all repos belonging to the logged-in user, newest first.
    Requires: Authorization: Bearer <token>
    """
    user_id = int(get_jwt_identity())
    repos = Repo.query.filter_by(user_id=user_id).order_by(Repo.created_at.desc()).all()
    return jsonify([r.to_dict() for r in repos])


@repos_bp.post('/api/repos')
@jwt_required()
def create_repo():
    """
    POST /api/repos
    Saves a new repo for the logged-in user.
    Requires: Authorization: Bearer <token>

    Body (JSON) — matches the frontend Project shape:
    {
      "name":        "my-repo",
      "owner":       "my-org",
      "repoName":    "my-repo",
      "platform":    "github",
      "githubUrl":   "https://github.com/my-org/my-repo",
      "repo":        "main",
      "errorType":   "PENDING_SCAN",
      "severity":    "medium",
      "stars":       42,
      "forks":       3,
      "language":    "TypeScript",
      "openIssues":  5,
      "description": "..."
    }
    """
    user_id = int(get_jwt_identity())
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400
    if not data.get('name'):
        return jsonify({'error': 'name is required'}), 400

    repo = Repo(
        user_id     = user_id,
        name        = data['name'],
        owner       = data.get('owner'),
        repo_name   = data.get('repoName'),
        platform    = data.get('platform', 'github'),
        github_url  = data.get('githubUrl'),
        branch      = data.get('repo', 'main'),
        error_type  = data.get('errorType', 'PENDING_SCAN'),
        severity    = data.get('severity', 'medium'),
        stars       = data.get('stars'),
        forks       = data.get('forks'),
        language    = data.get('language'),
        open_issues = data.get('openIssues'),
        description = data.get('description'),
    )
    db.session.add(repo)
    db.session.commit()
    return jsonify(repo.to_dict()), 201


@repos_bp.patch('/api/repos/<int:repo_id>')
@jwt_required()
def update_repo(repo_id: int):
    """
    PATCH /api/repos/<id>
    Updates mutable fields on a repo (category, healingStatus, severity, errorType).
    Requires: Authorization: Bearer <token>
    """
    user_id = int(get_jwt_identity())
    repo = db.session.get(Repo, repo_id)
    if not repo:
        return jsonify({'error': 'Repo not found'}), 404
    if repo.user_id != user_id:
        return jsonify({'error': 'Forbidden'}), 403

    data = request.get_json() or {}
    if 'category'       in data: repo.category       = data['category']
    if 'healingStatus'  in data: repo.healing_status  = data['healingStatus']
    if 'severity'       in data: repo.severity        = data['severity']
    if 'errorType'      in data: repo.error_type      = data['errorType']

    db.session.commit()
    return jsonify(repo.to_dict())


@repos_bp.delete('/api/repos/<int:repo_id>')
@jwt_required()
def delete_repo(repo_id: int):
    """
    DELETE /api/repos/<id>
    Removes a repo. Only the owner can delete their own repos.
    Requires: Authorization: Bearer <token>
    """
    user_id = int(get_jwt_identity())
    repo = db.session.get(Repo, repo_id)

    if not repo:
        return jsonify({'error': 'Repo not found'}), 404
    if repo.user_id != user_id:
        return jsonify({'error': 'Forbidden'}), 403

    db.session.delete(repo)
    db.session.commit()
    return jsonify({'deleted': True})
