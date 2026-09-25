"""
auth.py — login and registration endpoints.

Endpoints:
  POST /api/auth/register   → create a new user, return JWT token
  POST /api/auth/login      → verify credentials, return JWT token

The token is a JWT (JSON Web Token). The frontend stores it in localStorage
and sends it as   Authorization: Bearer <token>   on every authenticated request.
"""

from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token
from ..db import db
from ..models.user import User

auth_bp = Blueprint('auth', __name__)


def _str_field(data: dict, key: str) -> str:
    """Read a JSON field as a string — null/number/object values become ''."""
    value = data.get(key)
    return value if isinstance(value, str) else ''


@auth_bp.post('/api/auth/register')
def register():
    """
    POST /api/auth/register
    Body: { "email": "...", "password": "...", "name": "..." }
    Returns: { "token": "...", "user": { id, name, email } }
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Request body must be JSON'}), 400

    email    = _str_field(data, 'email').strip().lower()
    password = _str_field(data, 'password')
    name     = _str_field(data, 'name').strip()

    if not email or not password:
        return jsonify({'error': 'FIELDS_REQUIRED :: email and password'}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'EMAIL_ALREADY_EXISTS'}), 409

    user = User(name=name, email=email)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    token = create_access_token(identity=str(user.id))
    return jsonify({'token': token, 'user': user.to_dict()}), 201


@auth_bp.post('/api/auth/login')
def login():
    """
    POST /api/auth/login
    Body: { "email": "...", "password": "..." }
    Returns: { "token": "...", "user": { id, name, email } }
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Request body must be JSON'}), 400

    email    = _str_field(data, 'email').strip().lower()
    password = _str_field(data, 'password')

    if not email or not password:
        return jsonify({'error': 'FIELDS_REQUIRED :: email and password'}), 400

    user = User.query.filter_by(email=email).first()
    if not user or not user.check_password(password):
        return jsonify({'error': 'INVALID_CREDENTIALS'}), 401

    token = create_access_token(identity=str(user.id))
    return jsonify({'token': token, 'user': user.to_dict()})
