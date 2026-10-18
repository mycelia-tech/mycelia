"""Pure projection rules for versioned multi-profile speaker identity sets."""

from __future__ import annotations

from typing import Any, Iterable


def resolve_identity_projection(
    profile_snapshots: Iterable[dict[str, Any]],
    evaluations: Iterable[dict[str, Any]],
    manual: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve a segment only after every frozen profile has been evaluated."""
    snapshots = {str(item["profileId"]): item for item in profile_snapshots}
    excluded = {str(value) for value in (manual or {}).get("excludedProfileIds", [])}
    current: dict[str, dict[str, Any]] = {}
    for raw in evaluations:
        profile_id = str(raw.get("profileId"))
        snapshot = snapshots.get(profile_id)
        if not snapshot:
            continue
        if any(
            raw.get(field) != snapshot.get(field)
            for field in (
                "profileRevision",
                "calibrationId",
                "embeddingSpaceId",
            )
        ):
            continue
        evaluation = dict(raw)
        if profile_id in excluded:
            evaluation["state"] = "rejected"
        previous = current.get(profile_id)
        if previous is None or float(evaluation.get("score", -1)) > float(
            previous.get("score", -1)
        ):
            current[profile_id] = evaluation

    candidates = sorted(
        (
            {
                "profileId": profile_id,
                "profileRevision": item["profileRevision"],
                "calibrationId": item["calibrationId"],
                "state": item["state"],
                "score": item["score"],
            }
            for profile_id, item in current.items()
        ),
        key=lambda item: float(item["score"]),
        reverse=True,
    )
    base = {
        "candidates": candidates,
        "evaluatedProfiles": len(current),
        "expectedProfiles": len(snapshots),
        "topTwoMargin": (
            float(candidates[0]["score"]) - float(candidates[1]["score"])
            if len(candidates) > 1
            else None
        ),
    }

    if manual and manual.get("disposition") != "noise_or_unclear" and manual.get(
        "profileId"
    ):
        return {
            **base,
            "resolution": "identified",
            "profileId": str(manual["profileId"]),
            "source": "manual_projection",
            "complete": True,
        }
    if manual and manual.get("disposition") == "noise_or_unclear":
        return {
            **base,
            "resolution": "unknown",
            "profileId": None,
            "source": "manual_projection",
            "complete": True,
        }

    complete = bool(snapshots) and len(current) == len(snapshots)
    if not complete:
        return {
            **base,
            "resolution": "unclassified",
            "profileId": None,
            "source": "automatic",
            "complete": False,
        }

    matched = [item for item in candidates if item["state"] == "matched"]
    if len(matched) == 1:
        return {
            **base,
            "resolution": "identified",
            "profileId": matched[0]["profileId"],
            "candidates": matched,
            "source": "automatic",
            "complete": True,
        }
    if len(matched) > 1:
        return {
            **base,
            "resolution": "ambiguous",
            "profileId": None,
            "candidates": matched,
            "source": "automatic",
            "complete": True,
        }
    uncertain = [item for item in candidates if item["state"] == "uncertain"]
    if uncertain:
        return {
            **base,
            "resolution": "uncertain",
            "profileId": None,
            "candidates": uncertain,
            "source": "automatic",
            "complete": True,
        }
    return {
        **base,
        "resolution": "unknown",
        "profileId": None,
        "source": "automatic",
        "complete": True,
    }
