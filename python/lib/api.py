from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

import requests
from bson import ObjectId

from .config import ALLOW_INSECURE_TRANSPORT, client_id, client_secret, get_url

# ContextVars to store per-request job state
job_token_var: ContextVar[str | None] = ContextVar("job_token", default=None)
job_session_var: ContextVar[requests.Session | None] = ContextVar("job_session", default=None)


def create_session(token: str | None = None) -> requests.Session:
    """Create a Mycelia API session for one execution context."""
    session = requests.Session()
    session.verify = not ALLOW_INSECURE_TRANSPORT
    if token:
        session.headers.update({"Authorization": f"Bearer {token}"})
    return session


def exchange_api_key_for_jwt(*, timeout=None) -> str:
    """Exchange the API key for a JWT access token using OAuth client_credentials flow."""
    if not client_id or not client_secret:
        raise RuntimeError("MYCELIA_CLIENT_ID and MYCELIA_TOKEN must be set in environment")

    response = requests.post(
        get_url("oauth", "token"),
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        verify=not ALLOW_INSECURE_TRANSPORT,
        **({"timeout": timeout} if timeout is not None else {}),
    )
    response.raise_for_status()
    data = response.json()
    return data["access_token"]


def get_session() -> requests.Session:
    """Get or create a requests Session for the current job context."""
    session = job_session_var.get()
    if session is None:
        session = create_session(job_token_var.get())
        job_session_var.set(session)
    return session


def ensure_authorized() -> None:
    """Ensure the current session has a token. Raises if no token is available."""
    token = job_token_var.get()
    if not token:
        raise RuntimeError("No job token available in current context. Fallback authentication is disabled.")


def encode_typed(obj: Any) -> Any:
    if isinstance(obj, datetime):
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=UTC)
        iso = obj.astimezone(UTC).isoformat().replace("+00:00", "Z")
        return {"$date": iso}
    if isinstance(obj, ObjectId):
        return {"$oid": str(obj)}
    if isinstance(obj, dict):
        return {k: encode_typed(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [encode_typed(v) for v in obj]
    return obj
