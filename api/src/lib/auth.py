from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, Request

from src.lib.config import settings
from src.lib.exceptions import UnauthorizedError


def create_access_token(subject: str, extra: dict[str, object] | None = None) -> str:
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expire_minutes),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, object]:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as err:
        raise UnauthorizedError("Token has expired") from err
    except jwt.InvalidTokenError as err:
        raise UnauthorizedError("Invalid token") from err


def _extract_token(request: Request) -> str:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise UnauthorizedError("Missing or invalid Authorization header")
    return auth_header.removeprefix("Bearer ")


async def get_current_user(request: Request) -> dict[str, object]:
    token = _extract_token(request)
    return decode_access_token(token)


CurrentUser = Depends(get_current_user)
