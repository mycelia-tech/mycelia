from .api import get_session, ensure_authorized
from .config import get_url
from typing import Any
import json
import time


from bson import ObjectId
from datetime import datetime
import base64
import pytz
from requests.exceptions import RequestException, HTTPError
from .cancellation import check_cancelled, job_cancel_event_var


class EJsonEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, ObjectId):
            return {"$oid": str(obj)}
        if isinstance(obj, datetime):
            utc = obj.astimezone(pytz.utc)
            return {"$date": utc.isoformat().replace( "+00:00", "Z")}
        if isinstance(obj, bytes):
            return {
                "$binary": {
                    "base64": base64.b64encode(obj).decode(),
                    "subType": "00",
                }
            }
        return super().default(obj)


class EJsonDecoder(json.JSONDecoder):
    def __init__(self, *args, **kwargs):
        kwargs['object_hook'] = self._object_hook
        super().__init__(*args, **kwargs)

    @staticmethod
    def _object_hook(dct):
        if "$oid" in dct:
            return ObjectId(dct["$oid"])
        if "$date" in dct:
            iso = dct["$date"]
            if iso.endswith("Z"):
                iso = iso[:-1] + "+00:00"
            return datetime.fromisoformat(iso)
        if "$binary" in dct:
            binary_data = dct["$binary"]
            base64_str = binary_data["base64"]
            if binary_data.get("subType", "00") != "00":
                raise ValueError
            return base64.b64decode(base64_str)
        return dct


def _should_retry(exception: Exception) -> bool:
    if isinstance(exception, HTTPError):
        return exception.response is not None and exception.response.status_code >= 500
    return isinstance(exception, RequestException)


def _retry_safe(resource_name: str, body: dict) -> bool:
    """Only known stateless reads and stable insert-if-absent writes may replay.

    Cursors advance server state, and even a $set update can have meaningful
    matched/modified counts. Neither is automatically safe to repeat.
    """
    action = body.get("action")
    if resource_name == "mongo":
        if action in {"find", "findOne", "count", "distinct"}:
            return True
        if action == "updateOne":
            query, update = body.get("query", {}), body.get("update", {})
            return (set(query) == {"_id"} and isinstance(query["_id"], (str, ObjectId))
                    and set(update) == {"$setOnInsert"} and body.get("options", {}).get("upsert") is True)
    return resource_name == "config" and action == "get"


def call_resource(resource_name: str, body: dict) -> Any:
    attempts = 3 if _retry_safe(resource_name, body) else 1
    for attempt in range(attempts):
        check_cancelled()
        try:
            return call_resource_once(resource_name, body, timeout=(3.0, 30.0))
        except RequestException as exc:
            if attempt + 1 == attempts or not _should_retry(exc):
                raise
            delay = float(2 ** attempt)
            event = job_cancel_event_var.get()
            if event is not None:
                event.wait(delay)
            else:
                time.sleep(delay)
            check_cancelled()
    raise AssertionError("Unreachable retry state")


def call_resource_once(
    resource_name: str,
    body: dict,
    *,
    timeout: tuple[float, float] = (3.0, 10.0),
) -> Any:
    """Call a worker resource once with a bounded network deadline.

    Cleanup intentionally remains callable after cancellation. Callers own
    retry decisions; Mongo operations still carry their own maxTimeMS.
    """
    ensure_authorized()
    session = get_session()
    response = session.post(
        get_url("api", "resource", resource_name),
        data=json.dumps(body, cls=EJsonEncoder),
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )
    response.raise_for_status()
    return json.loads(response.text, cls=EJsonDecoder)
