"""Versioned, tri-state identity matching over stored diarization embeddings."""

from __future__ import annotations

import logging
import math
import time
from datetime import UTC, datetime
from typing import Any, Callable, Dict, Literal, Optional

import numpy as np
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, Field, model_validator

from lib.resources import call_resource
from speaker_identification.identity_model_set import resolve_identity_projection
from speaker_identification.profiles import get_profile_by_id

UNKNOWN_SPACES = {"", "legacy-unknown", "unknown", None}
FULL_TARGET_PRECISION = 0.98
PILOT_MIN_TARGET_PRECISION = 0.90
PILOT_MAX_RANGE_HOURS = 24
SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS = 20
SPEAKER_CALIBRATION_MIN_CHECK_AUTO_MATCHES = 20
SPEAKER_CALIBRATION_MIN_CHECK_AUTO_REJECTIONS = 20
logger = logging.getLogger(__name__)


class IdentitySourceSnapshotChanged(RuntimeError):
    """The materialized source changed after campaign planning."""


def classify_identity(
    score: float,
    *,
    positive_threshold: float,
    negative_threshold: float,
    negative_decision_mode: Literal["calibrated", "uncertain_only"] = "calibrated",
    segment_space: Optional[str] = None,
    profile_space: Optional[str] = None,
    allow_legacy_compatibility: bool = False,
) -> Literal["matched", "rejected", "uncertain"]:
    if negative_threshold >= positive_threshold:
        raise ValueError("negative threshold must be lower than positive threshold")
    if negative_decision_mode not in {"calibrated", "uncertain_only"}:
        raise ValueError(f"Unknown negative decision mode: {negative_decision_mode}")
    if segment_space != profile_space:
        raise ValueError(
            f"Embedding space mismatch: segment={segment_space!r}, profile={profile_space!r}"
        )
    if segment_space in UNKNOWN_SPACES and not allow_legacy_compatibility:
        raise ValueError(
            "Matching an unknown embedding space requires validated compatibility"
        )
    if score >= positive_threshold:
        return "matched"
    if negative_decision_mode == "calibrated" and score <= negative_threshold:
        return "rejected"
    return "uncertain"


class IdentityProfileSnapshot(BaseModel):
    """Immutable profile inputs frozen into an identity model set."""

    model_config = ConfigDict(extra="allow")

    profileId: str = Field(min_length=1)
    profileRevision: int = Field(ge=1)
    calibrationId: str = Field(min_length=1)
    embeddingSpaceId: str = Field(min_length=1)
    evidenceSnapshotHash: Optional[str] = None


class IdentitySourceSnapshot(BaseModel):
    """Published source-index revision used to plan a model-set campaign."""

    model_config = ConfigDict(extra="allow")

    buildId: str = Field(min_length=1)
    revision: int = Field(ge=1)
    membershipRevision: int = Field(ge=0)


class SpeakerIdentityJobData(BaseModel):
    runId: str
    profileId: Optional[str] = None
    profileRevision: Optional[int] = Field(default=None, ge=1)
    calibrationId: Optional[str] = None
    evidenceSnapshotHash: Optional[str] = None
    modelSetId: Optional[str] = None
    profileSnapshots: list[IdentityProfileSnapshot] = Field(default_factory=list)
    sourceSnapshot: Optional[IdentitySourceSnapshot] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    limit: int = Field(default=1000, ge=1, le=10000)
    cursor: Optional[str] = None
    campaignId: Optional[str] = None
    snapshotCutoff: Optional[datetime] = None
    partitions: list[dict[str, Any]] = Field(default_factory=list)
    partitionIndex: int = Field(default=0, ge=0)
    campaignTotalSegments: Optional[int] = Field(default=None, ge=0)
    campaignMode: Optional[Literal["classify_existing", "classify_automatic"]] = None

    @model_validator(mode="after")
    def validate_range(self) -> "SpeakerIdentityJobData":
        if self.start and self.end and self.end <= self.start:
            raise ValueError("end must be after start")
        if self.modelSetId:
            if not self.profileSnapshots:
                raise ValueError("profileSnapshots are required for a model-set job")
            if self.sourceSnapshot is None:
                raise ValueError("sourceSnapshot is required for a model-set job")
            if not self.partitions:
                raise ValueError("partitions are required for a model-set job")
            if any(
                int(partition.get("sourceSegments", 0) or 0) <= 0
                or not partition.get("maxSegmentId")
                for partition in self.partitions
            ):
                raise ValueError(
                    "Every model-set partition requires frozen sourceSegments "
                    "and maxSegmentId"
                )
            profile_ids = [snapshot.profileId for snapshot in self.profileSnapshots]
            if len(profile_ids) != len(set(profile_ids)):
                raise ValueError("profileSnapshots must contain unique profiles")
            spaces = {snapshot.embeddingSpaceId for snapshot in self.profileSnapshots}
            if len(spaces) != 1:
                raise ValueError("A model-set job requires one shared embedding space")
        elif not all(
            (
                self.profileId,
                self.profileRevision is not None,
                self.calibrationId,
                self.evidenceSnapshotHash,
            )
        ):
            raise ValueError(
                "Legacy identity jobs require profileId, profileRevision, "
                "calibrationId, and evidenceSnapshotHash"
            )
        if self.partitions:
            if self.partitionIndex >= len(self.partitions):
                raise ValueError("partitionIndex is outside the campaign plan")
            partition = self.partitions[self.partitionIndex]
            if partition.get("runId") != self.runId:
                raise ValueError("runId does not match the current campaign partition")
        return self


def _cosine(a: list[float], b: list[float]) -> float:
    av = np.asarray(a, dtype=np.float32)
    bv = np.asarray(b, dtype=np.float32)
    if av.shape != bv.shape:
        raise ValueError(f"Embedding dimension mismatch: {av.shape} != {bv.shape}")
    denominator = float(np.linalg.norm(av) * np.linalg.norm(bv))
    if denominator == 0:
        raise ValueError("Cannot match a zero-length embedding")
    return float(np.dot(av, bv) / denominator)


def _profile_score(
    segment_embedding: list[float],
    profile: dict[str, Any],
    strategy: Literal["centroid", "max_prototype", "top2_prototype_mean"],
) -> float:
    if strategy == "centroid":
        return _cosine(segment_embedding, profile["embedding"])
    prototypes = [
        item.get("embedding")
        for item in profile.get("embeddingPrototypes", [])
        if isinstance(item, dict) and isinstance(item.get("embedding"), list)
    ]
    if not prototypes:
        raise ValueError(
            f"Calibration requires {strategy}, but the profile has no saved prototypes"
        )
    scores = sorted(
        (_cosine(segment_embedding, prototype) for prototype in prototypes),
        reverse=True,
    )
    if strategy == "max_prototype":
        return scores[0]
    return scores[0] if len(scores) == 1 else (scores[0] + scores[1]) / 2


def _campaign_call(request: Dict[str, Any]) -> Any:
    """Observability failures must not discard valid identity decisions."""
    try:
        return call_resource("mongo", request)
    except Exception as exc:
        logger.warning("Could not persist speaker identity campaign telemetry: %s", exc)
        return None


def _update_campaign(
    campaign_id: str, fields: Dict[str, Any], *, owner_job_id: str | None = None
) -> None:
    query: Dict[str, Any] = {"campaignId": campaign_id}
    if owner_job_id is not None:
        query.update({"active": True, "currentJobId": owner_job_id})
    _campaign_call(
        {
            "action": "updateOne",
            "collection": "speaker_identity_campaigns",
            "query": query,
            "update": {"$set": {**fields, "updatedAt": datetime.now(UTC)}},
            "options": {"upsert": owner_job_id is None},
        }
    )


def _require_campaign_ownership(campaign_id: str, job_id: str) -> Dict[str, Any]:
    campaign = call_resource(
        "mongo",
        {
            "action": "findOne",
            "collection": "speaker_identity_campaigns",
            "query": {
                "campaignId": campaign_id,
                "active": True,
                "currentJobId": job_id,
            },
        },
    )
    if not campaign:
        raise ValueError(
            "Speaker identity campaign no longer owns this job; stop this batch"
        )
    return campaign


def _rate_estimate(samples: list[float]) -> Optional[float]:
    recent = [float(value) for value in samples[-10:] if value > 0]
    if len(recent) < 2:
        return None
    estimate = recent[0]
    for value in recent[1:]:
        estimate = 0.35 * value + 0.65 * estimate
    return estimate


def _validated_calibration_policy(
    calibration: dict[str, Any], data: SpeakerIdentityJobData
) -> tuple[Literal["full", "pilot"], float | None]:
    target_precision = float(calibration.get("targetPrecision", 0))
    validation = calibration.get("validationMetrics") or {}
    if (
        not math.isfinite(target_precision)
        or target_precision > 1
        or float(validation.get("positivePrecision", 0)) < target_precision
    ):
        raise ValueError(
            "Calibration does not prove the required independent validation precision"
        )
    if (
        int(validation.get("positives", 0)) < SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS
        or int(validation.get("negatives", 0)) < SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS
        or int(validation.get("identified", 0))
        < SPEAKER_CALIBRATION_MIN_CHECK_AUTO_MATCHES
    ):
        raise ValueError(
            "Calibration independent validation set has insufficient support: "
            "requires at least 20 positives, 20 negatives, and 20 identified "
            "auto-matches"
        )
    negative_mode = _validated_negative_decision_mode(
        calibration, float(calibration.get("negativeThreshold", -1))
    )
    if negative_mode == "calibrated" and (
        int(validation.get("rejected", 0))
        < SPEAKER_CALIBRATION_MIN_CHECK_AUTO_REJECTIONS
        or float(validation.get("negativePrecision", 0)) < target_precision
    ):
        raise ValueError(
            "Calibration automatic not-target decisions are not proven on "
            "independent validation; use uncertain-only mode"
        )

    configured_policy = calibration.get("classificationPolicy")
    if target_precision >= FULL_TARGET_PRECISION:
        if configured_policy not in (None, "full"):
            raise ValueError("Full calibration has an invalid classification policy")
        if calibration.get("maxRangeHours") is not None:
            raise ValueError("Full calibration must not have a range limit")
        if calibration.get("operatorAcceptedLowerPrecision") is True:
            raise ValueError("Full calibration cannot accept lower-precision risk")
        return "full", None

    if (
        target_precision < PILOT_MIN_TARGET_PRECISION
        or configured_policy != "pilot"
        or calibration.get("operatorAcceptedLowerPrecision") is not True
        or float(calibration.get("maxRangeHours", 0)) != PILOT_MAX_RANGE_HOURS
    ):
        raise ValueError(
            "Lower-precision calibration requires an explicitly accepted bounded pilot policy"
        )
    if data.start is None or data.end is None:
        raise ValueError("Pilot speaker identity jobs require both start and end")
    if data.end <= data.start:
        raise ValueError("Pilot speaker identity job end must be after start")
    range_hours = (data.end - data.start).total_seconds() / 3600
    if range_hours > PILOT_MAX_RANGE_HOURS:
        raise ValueError(
            f"Pilot speaker identity range cannot exceed {PILOT_MAX_RANGE_HOURS} hours"
        )
    return "pilot", float(PILOT_MAX_RANGE_HOURS)


def _validate_calibration_head_and_evidence(
    profile: dict[str, Any],
    calibration: dict[str, Any],
    data: SpeakerIdentityJobData,
    classification_policy: Literal["full", "pilot"],
) -> None:
    try:
        calibration_evidence_revision = int(calibration.get("evidenceRevision", 0) or 0)
        profile_evidence_revision = int(
            profile.get("calibrationEvidenceRevision", 0) or 0
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("Calibration evidence revision is invalid") from exc
    if calibration_evidence_revision != profile_evidence_revision:
        raise ValueError(
            "Voice labels changed after calibration; recalculate calibration and "
            "run identity preflight again"
        )

    active_ids = profile.get("activeCalibrationIds")
    policy_head = (
        active_ids.get(classification_policy) if isinstance(active_ids, dict) else None
    )
    backward_head = profile.get("activeCalibrationId")
    authoritative_head = policy_head or backward_head
    has_any_head = bool(backward_head) or bool(active_ids)
    if authoritative_head:
        if str(authoritative_head) != data.calibrationId:
            raise ValueError(
                f"Calibration is no longer the active {classification_policy} "
                "profile calibration; run identity preflight again"
            )
        return
    if profile.get("calibrationHeadsInitialized") is not True and not has_any_head:
        return
    raise ValueError(
        f"The profile has no active {classification_policy} calibration; "
        "recalculate calibration and run identity preflight again"
    )


def _validated_negative_decision_mode(
    calibration: dict[str, Any], negative_threshold: float
) -> Literal["calibrated", "uncertain_only"]:
    mode = calibration.get("negativeDecisionMode", "calibrated")
    if mode == "calibrated":
        return "calibrated"
    if mode == "uncertain_only" and negative_threshold == -1:
        return "uncertain_only"
    raise ValueError("Calibration has an invalid negative decision mode")


def _validated_positive_threshold_provenance(
    calibration: dict[str, Any],
    positive_threshold: float,
    classification_policy: Literal["full", "pilot"],
) -> tuple[float, Literal["automatic", "operator_stricter"]]:
    recommended = float(
        calibration.get("recommendedPositiveThreshold", positive_threshold)
    )
    source = calibration.get("positiveThresholdSource", "automatic")
    if not math.isfinite(recommended):
        raise ValueError("Calibration has an invalid recommended positive threshold")
    if source == "automatic" and positive_threshold == recommended:
        return recommended, "automatic"
    if (
        source == "operator_stricter"
        and classification_policy == "pilot"
        and positive_threshold > recommended
    ):
        return recommended, "operator_stricter"
    raise ValueError("Calibration has invalid positive threshold provenance")


def _identity_query(
    data: SpeakerIdentityJobData,
    classification_policy: Literal["full", "pilot"],
) -> Dict[str, Any]:
    """Select segments not yet evaluated with this profile/calibration."""
    expected_validity = "verified" if classification_policy == "full" else "provisional"
    current_identity = {
        "speakerIdentity.calibrationId": data.calibrationId,
        "speakerIdentity.profileRevision": data.profileRevision,
        "speakerIdentity.embeddingSpaceId": data.partitions[data.partitionIndex].get(
            "embeddingSpaceId"
        )
        if data.partitions
        else {"$exists": True},
        "speakerIdentity.source": "automatic",
        "speakerIdentity.validity": expected_validity,
        "$or": [
            {"speakerIdentity.profileId": ObjectId(data.profileId)},
            {"speakerIdentity.topCandidate.profileId": ObjectId(data.profileId)},
        ],
    }
    query: Dict[str, Any] = {
        "runId": data.runId,
        "lifecycleStatus": "active",
        "embeddingSpaceId": data.partitions[data.partitionIndex].get("embeddingSpaceId")
        if data.partitions
        else {"$exists": True},
        "embedding": {"$exists": True},
        "$nor": [current_identity],
    }
    if data.start or data.end:
        query["start"] = {}
        if data.start:
            query["start"]["$gte"] = data.start
        if data.end:
            query["start"]["$lt"] = data.end
    if data.snapshotCutoff:
        query.setdefault("start", {})["$lt"] = min(
            data.snapshotCutoff,
            data.end or data.snapshotCutoff,
        )
    if classification_policy == "pilot":
        query["$nor"].extend(
            [
                {"speakerIdentity.validity": "verified"},
                {"speakerIdentity.classificationPolicy": "full"},
            ]
        )
    return query


def _source_query_for_partition(
    data: SpeakerIdentityJobData, partition: dict[str, Any]
) -> Dict[str, Any]:
    query: Dict[str, Any] = {
        "runId": partition["runId"],
        "lifecycleStatus": "active",
        "embeddingSpaceId": partition["embeddingSpaceId"],
        "embedding": {"$exists": True},
    }
    if data.start or data.end or data.snapshotCutoff:
        start: Dict[str, Any] = {}
        if data.start:
            start["$gte"] = data.start
        upper = data.end
        if data.snapshotCutoff and (upper is None or data.snapshotCutoff < upper):
            upper = data.snapshotCutoff
        if upper:
            start["$lt"] = upper
        query["start"] = start
    return query


def _snapshot_signature(items: list[dict[str, Any]]) -> list[tuple[str, int, str, str]]:
    return sorted(
        (
            str(item.get("profileId", "")),
            int(item.get("profileRevision", 0) or 0),
            str(item.get("calibrationId", "")),
            str(item.get("embeddingSpaceId", "")),
        )
        for item in items
    )


def _source_snapshot_membership(snapshot: dict[str, Any] | None) -> int:
    snapshot = snapshot or {}
    return int(snapshot.get("membershipRevision", -1) or 0)


def _model_set_segment_query(data: SpeakerIdentityJobData) -> Dict[str, Any]:
    """Return the frozen source slice for a model-set batch."""
    embedding_space = data.profileSnapshots[0].embeddingSpaceId
    query: Dict[str, Any] = {
        "runId": data.runId,
        "lifecycleStatus": "active",
        "embeddingSpaceId": embedding_space,
        "embedding": {"$exists": True},
    }
    if data.start or data.end or data.snapshotCutoff:
        start: Dict[str, Any] = {}
        if data.start:
            start["$gte"] = data.start
        upper = data.end
        if data.snapshotCutoff and (upper is None or data.snapshotCutoff < upper):
            upper = data.snapshotCutoff
        if upper:
            start["$lt"] = upper
        if start:
            query["start"] = start

    partition = data.partitions[data.partitionIndex] if data.partitions else {}
    max_segment_id = partition.get("maxSegmentId")
    object_id_ceiling = (
        ObjectId(str(max_segment_id))
        if max_segment_id and ObjectId.is_valid(str(max_segment_id))
        else None
    )
    after_segment_id = partition.get("afterSegmentId")
    lower_bound = data.cursor or after_segment_id
    object_id_floor = (
        ObjectId(str(lower_bound))
        if lower_bound and ObjectId.is_valid(str(lower_bound))
        else None
    )
    if object_id_floor or object_id_ceiling:
        query["_id"] = {}
        if object_id_floor:
            query["_id"]["$gt"] = object_id_floor
        if object_id_ceiling:
            query["_id"]["$lte"] = object_id_ceiling
    return query


def _load_model_set_context(
    data: SpeakerIdentityJobData,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Validate that every frozen model input is still authoritative."""
    assert data.modelSetId is not None
    assert data.sourceSnapshot is not None

    model_set = call_resource(
        "mongo",
        {
            "action": "findOne",
            "collection": "identity_model_sets",
            "query": {"modelSetId": data.modelSetId},
        },
    )
    if not model_set:
        raise ValueError(f"Identity model set not found: {data.modelSetId}")
    if model_set.get("status") not in {"building", "ready", "active"}:
        raise ValueError("Identity model set is no longer buildable")

    requested_snapshots = [item.model_dump() for item in data.profileSnapshots]
    persisted_snapshots = model_set.get("profiles") or model_set.get("profileSnapshots")
    if not isinstance(persisted_snapshots, list) or _snapshot_signature(
        persisted_snapshots
    ) != _snapshot_signature(requested_snapshots):
        raise ValueError("Identity model set profile snapshot changed")

    requested_source = data.sourceSnapshot.model_dump()
    persisted_source = model_set.get("sourceSnapshot")
    if model_set.get("status") in {"building", "ready"} and (
        not isinstance(persisted_source, dict)
        or _source_snapshot_membership(persisted_source)
        != _source_snapshot_membership(requested_source)
    ):
        raise ValueError("Identity model set source snapshot changed")

    source_index = call_resource(
        "mongo",
        {
            "action": "findOne",
            "collection": "speaker_identity_source_index",
            "query": {"_id": "active"},
        },
    )
    current_membership_revision = int(
        (source_index or {}).get("membershipRevision", -1) or 0
    )
    if current_membership_revision != data.sourceSnapshot.membershipRevision:
        raise IdentitySourceSnapshotChanged(
            "Speaker identity source snapshot is stale; run identity preflight again"
        )

    contexts: list[dict[str, Any]] = []
    for snapshot in data.profileSnapshots:
        profile = get_profile_by_id(snapshot.profileId)
        if not profile:
            raise ValueError(f"Profile not found: {snapshot.profileId}")
        if int(profile.get("revision", 1)) != snapshot.profileRevision:
            raise ValueError(
                f"Profile {snapshot.profileId} revision changed; build a new model set"
            )
        if profile.get("embeddingSpaceId") != snapshot.embeddingSpaceId:
            raise ValueError(
                f"Profile {snapshot.profileId} embedding space changed; build a new model set"
            )

        calibration = call_resource(
            "mongo",
            {
                "action": "findOne",
                "collection": "speaker_calibrations",
                "query": {
                    "calibrationId": snapshot.calibrationId,
                    "profileId": snapshot.profileId,
                },
            },
        )
        if not calibration or calibration.get("status") != "validated":
            raise ValueError(
                f"Profile {snapshot.profileId} requires a validated calibration"
            )
        if (
            calibration.get("serverComputed") is not True
            or calibration.get("contractVersion") != "server-computed-v1"
            or calibration.get("computedBy") != "speaker-segments"
            or calibration.get("lifecycleStatus") != "active"
        ):
            raise ValueError(
                f"Profile {snapshot.profileId} calibration is stale; build a new model set"
            )
        if int(calibration.get("profileRevision", 0)) != snapshot.profileRevision:
            raise ValueError(
                f"Profile {snapshot.profileId} calibration revision is stale"
            )
        if calibration.get("embeddingSpaceId") != snapshot.embeddingSpaceId:
            raise ValueError(
                f"Profile {snapshot.profileId} calibration uses another embedding space"
            )
        evidence_hash = str(calibration.get("evidenceSnapshotHash", ""))
        if not evidence_hash or (
            snapshot.evidenceSnapshotHash
            and snapshot.evidenceSnapshotHash != evidence_hash
        ):
            raise ValueError(
                f"Profile {snapshot.profileId} calibration evidence changed"
            )

        frozen_data = data.model_copy(
            update={
                "profileId": snapshot.profileId,
                "profileRevision": snapshot.profileRevision,
                "calibrationId": snapshot.calibrationId,
                "evidenceSnapshotHash": evidence_hash,
            }
        )
        policy, max_range_hours = _validated_calibration_policy(
            calibration, frozen_data
        )
        if policy != "full":
            raise ValueError("Identity model sets require full calibrations")
        _validate_calibration_head_and_evidence(
            profile, calibration, frozen_data, policy
        )
        positive = float(calibration["positiveThreshold"])
        negative = float(calibration["negativeThreshold"])
        negative_mode = _validated_negative_decision_mode(calibration, negative)
        recommended_positive, threshold_source = (
            _validated_positive_threshold_provenance(calibration, positive, policy)
        )
        strategy = calibration.get("scoringStrategy", "centroid")
        if strategy not in {
            "centroid",
            "max_prototype",
            "top2_prototype_mean",
        }:
            raise ValueError(
                f"Profile {snapshot.profileId} calibration has an unknown scoring strategy"
            )
        contexts.append(
            {
                "snapshot": snapshot,
                "profile": profile,
                "calibration": calibration,
                "policy": policy,
                "maxRangeHours": max_range_hours,
                "positive": positive,
                "negative": negative,
                "negativeMode": negative_mode,
                "recommendedPositive": recommended_positive,
                "thresholdSource": threshold_source,
                "strategy": strategy,
                "allowLegacy": bool(calibration.get("allowLegacyCompatibility", False)),
                "evidenceSnapshotHash": evidence_hash,
            }
        )
    return model_set, contexts


def _latest_annotations_by_segment(
    segments: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    if not segments:
        return {}
    segment_ids = [segment["_id"] for segment in segments]
    original_ids = list(
        {
            segment.get("original_id", segment.get("original"))
            for segment in segments
            if segment.get("original_id", segment.get("original")) is not None
        }
    )
    starts = [segment.get("start") for segment in segments if segment.get("start")]
    ends = [segment.get("end") for segment in segments if segment.get("end")]
    overlap_query: dict[str, Any] | None = None
    if original_ids and starts and ends:
        overlap_query = {
            "originalId": {"$in": original_ids},
            "start": {"$lt": max(ends)},
            "end": {"$gt": min(starts)},
        }
    identity_queries: list[dict[str, Any]] = [{"segmentId": {"$in": segment_ids}}]
    if overlap_query:
        identity_queries.append(overlap_query)
    annotations = (
        call_resource(
            "mongo",
            {
                "action": "find",
                "collection": "speaker_annotations",
                "query": {
                    "source": "manual",
                    "$or": identity_queries,
                },
                "options": {
                    "sort": {"updatedAt": -1, "createdAt": -1},
                    "limit": len(segments) * 20,
                },
            },
        )
        or []
    )
    exact: dict[str, list[dict[str, Any]]] = {}
    by_original: dict[str, list[dict[str, Any]]] = {}
    for annotation in annotations:
        segment_id = str(annotation.get("segmentId", ""))
        if segment_id:
            exact.setdefault(segment_id, []).append(annotation)
        original_id = str(annotation.get("originalId", ""))
        if original_id:
            by_original.setdefault(original_id, []).append(annotation)

    def timestamp(annotation: dict[str, Any]) -> datetime:
        value = annotation.get("updatedAt") or annotation.get("createdAt")
        if not isinstance(value, datetime):
            return datetime.min.replace(tzinfo=UTC)
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

    def is_inactive(annotation: dict[str, Any]) -> bool:
        return (
            annotation.get("active") is False
            or annotation.get("status") in {"superseded", "deleted", "cleared"}
            or annotation.get("supersededAt") is not None
            or annotation.get("deletedAt") is not None
            or annotation.get("clearedAt") is not None
        )

    def is_clear(annotation: dict[str, Any]) -> bool:
        return (
            annotation.get("disposition") in {"clear", "cleared"}
            or annotation.get("action") in {"clear", "clear_override"}
            or annotation.get("clear") is True
        )

    def is_noise(annotation: dict[str, Any]) -> bool:
        return (
            annotation.get("disposition") == "noise_or_unclear"
            or annotation.get("skipReason") == "noise_or_unclear"
        )

    def project(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
        # An assignment is global for the segment, while negative evidence is
        # profile-specific. Therefore a newer "not Belka" annotation must not
        # hide an older still-current "this is Sky" assignment.
        ordered = sorted(candidates, key=timestamp, reverse=True)
        superseded_ids = {
            str(value)
            for annotation in ordered
            for value in (
                [annotation.get("supersedesAnnotationId")]
                + list(annotation.get("supersedesAnnotationIds", []))
            )
            if value is not None
        }
        current: list[dict[str, Any]] = []
        seen: set[str] = set()
        for annotation in ordered:
            key = str(annotation.get("_id") or id(annotation))
            if key in seen:
                continue
            seen.add(key)
            if key in superseded_ids or is_inactive(annotation):
                continue
            if is_clear(annotation):
                # A clear tombstone ends the history before it, while allowing
                # a later correction (already collected above) to stand.
                break
            current.append(annotation)
        if not current:
            return None

        positives = [
            annotation
            for annotation in current
            if annotation.get("profileId") is not None and not is_noise(annotation)
        ]
        positive = max(positives, key=timestamp) if positives else None
        noises = [annotation for annotation in current if is_noise(annotation)]
        noise = max(noises, key=timestamp) if noises else None

        excluded_profile_ids = {
            str(value)
            for annotation in current
            if not is_noise(annotation)
            for value in annotation.get("excludedProfileIds", [])
        }
        for annotation in current:
            excluded_profile_ids.difference_update(
                str(value)
                for value in annotation.get(
                    "clearedProfileIds",
                    annotation.get("clearProfileIds", []),
                )
            )
        profile_id = str(positive["profileId"]) if positive is not None else None
        if profile_id:
            excluded_profile_ids.discard(profile_id)

        if noise is not None and (
            positive is None or timestamp(noise) > timestamp(positive)
        ):
            disposition = "noise_or_unclear"
            profile_id = None
        else:
            disposition = "speaker"
        if profile_id is None and not excluded_profile_ids and disposition == "speaker":
            return None
        return {
            "profileId": profile_id,
            "excludedProfileIds": sorted(excluded_profile_ids),
            "disposition": disposition,
        }

    latest: dict[str, dict[str, Any]] = {}
    for segment in segments:
        segment_key = str(segment["_id"])
        applicable = list(exact.get(segment_key, []))
        original_key = str(segment.get("original_id", segment.get("original", "")))
        segment_start = segment.get("start")
        segment_end = segment.get("end")
        if segment_start and segment_end:
            applicable.extend(
                candidate
                for candidate in by_original.get(original_key, [])
                if candidate.get("start")
                and candidate.get("end")
                and candidate["start"] < segment_end
                and candidate["end"] > segment_start
            )
        projection = project(applicable)
        if projection is not None:
            latest[segment_key] = projection
    return latest


def _projection_partition_query(
    data: SpeakerIdentityJobData, partition: dict[str, Any]
) -> dict[str, Any]:
    query: dict[str, Any] = {
        "modelSetId": data.modelSetId,
        "runId": str(partition["runId"]),
        "embeddingSpaceId": str(partition["embeddingSpaceId"]),
    }
    start: dict[str, Any] = {}
    if data.start:
        start["$gte"] = data.start
    upper = data.end
    if data.snapshotCutoff and (upper is None or data.snapshotCutoff < upper):
        upper = data.snapshotCutoff
    if upper:
        start["$lt"] = upper
    if start:
        query["start"] = start
    max_segment_id = partition.get("maxSegmentId")
    if max_segment_id and ObjectId.is_valid(str(max_segment_id)):
        query["segmentId"] = {"$lte": ObjectId(str(max_segment_id))}
    return query


def _model_set_remaining(
    data: SpeakerIdentityJobData,
) -> tuple[int, Optional[int], bool]:
    """Reconcile persisted projections against every frozen partition."""
    remaining = 0
    first_incomplete: Optional[int] = None
    overfilled = False
    for index, partition in enumerate(data.partitions):
        projected = int(
            call_resource(
                "mongo",
                {
                    "action": "count",
                    "collection": "speaker_identity_projections",
                    "query": _projection_partition_query(data, partition),
                    "options": {"maxTimeMS": 10_000},
                },
            )
            or 0
        )
        expected = int(partition["sourceSegments"])
        if projected > expected:
            overfilled = True
        missing = max(expected - projected, 0)
        remaining += missing
        if missing and first_incomplete is None:
            first_incomplete = index
    return remaining, first_incomplete, overfilled


def _model_set_source_changed_result(
    job_id: str,
    data: SpeakerIdentityJobData,
    progress_callback: Callable[[Dict[str, Any]], None],
    reason: str,
) -> Dict[str, Any]:
    if data.modelSetId:
        call_resource(
            "mongo",
            {
                "action": "updateOne",
                "collection": "identity_model_sets",
                "query": {
                    "modelSetId": data.modelSetId,
                    "status": "building",
                },
                "update": {
                    "$set": {
                        "status": "failed",
                        "failureReason": reason,
                        "failedAt": datetime.now(UTC),
                        "updatedAt": datetime.now(UTC),
                    }
                },
            },
        )
    progress = {
        "stage": "identity",
        "modelSetId": data.modelSetId,
        "processed": 0,
        "hasMore": False,
        "campaignStatus": "source_changed",
        "sourceChanged": True,
        "message": reason,
    }
    if data.campaignId:
        _update_campaign(
            data.campaignId,
            {
                "status": "source_changed",
                "active": False,
                "sourceChanged": True,
                "failureReason": reason,
                "currentJobId": job_id,
                "finishedAt": datetime.now(UTC),
            },
            owner_job_id=job_id,
        )
    progress_callback(progress)
    return {
        **progress,
        "cursor": data.cursor,
        "nextRunId": None,
        "nextPartitionIndex": None,
        "advancePartition": False,
        "campaignId": data.campaignId,
    }


def _process_model_set_speaker_identity_job(
    job_id: str,
    data: SpeakerIdentityJobData,
    progress_callback: Callable[[Dict[str, Any]], None],
) -> Dict[str, Any]:
    """Evaluate every frozen profile once and persist an idempotent projection."""
    started = time.time()
    campaign = (
        _require_campaign_ownership(data.campaignId, job_id) if data.campaignId else {}
    )
    try:
        model_set, contexts = _load_model_set_context(data)
    except IdentitySourceSnapshotChanged as exc:
        return _model_set_source_changed_result(
            job_id, data, progress_callback, str(exc)
        )
    assert data.modelSetId is not None

    candidates = (
        call_resource(
            "mongo",
            {
                "action": "find",
                "collection": "diarizations",
                "query": _model_set_segment_query(data),
                "options": {"sort": {"_id": 1}, "limit": data.limit + 1},
            },
        )
        or []
    )
    segments = candidates[: data.limit]
    annotations = _latest_annotations_by_segment(segments)
    now = datetime.now(UTC)
    evaluation_operations: list[dict[str, Any]] = []
    projection_operations: list[dict[str, Any]] = []
    compatibility_operations: list[dict[str, Any]] = []
    resolution_counts = {
        "identified": 0,
        "ambiguous": 0,
        "uncertain": 0,
        "unknown": 0,
        "unclassified": 0,
    }

    for segment in segments:
        evaluations: list[dict[str, Any]] = []
        for context in contexts:
            snapshot: IdentityProfileSnapshot = context["snapshot"]
            score = _profile_score(
                segment["embedding"], context["profile"], context["strategy"]
            )
            state = classify_identity(
                score,
                positive_threshold=context["positive"],
                negative_threshold=context["negative"],
                negative_decision_mode=context["negativeMode"],
                segment_space=segment.get("embeddingSpaceId"),
                profile_space=snapshot.embeddingSpaceId,
                allow_legacy_compatibility=context["allowLegacy"],
            )
            evaluation = {
                "segmentId": segment["_id"],
                "runId": data.runId,
                "embeddingSpaceId": snapshot.embeddingSpaceId,
                "profileId": snapshot.profileId,
                "profileRevision": snapshot.profileRevision,
                "calibrationId": snapshot.calibrationId,
                "state": state,
                "score": round(score, 6),
                "positiveThreshold": context["positive"],
                "negativeThreshold": context["negative"],
                "negativeDecisionMode": context["negativeMode"],
                "evidenceSnapshotHash": context["evidenceSnapshotHash"],
                "matcherVersion": "profile-prototypes-v3",
                "scoringStrategy": context["strategy"],
                "modelProvenance": context["profile"].get("runtimeProvenance"),
                "evaluatedAt": now,
            }
            evaluations.append(evaluation)
            evaluation_operations.append(
                {
                    "updateOne": {
                        "filter": {
                            "segmentId": segment["_id"],
                            "profileId": snapshot.profileId,
                            "profileRevision": snapshot.profileRevision,
                            "calibrationId": snapshot.calibrationId,
                        },
                        "update": {
                            "$set": evaluation,
                            "$setOnInsert": {"createdAt": now},
                            "$addToSet": {"modelSetIds": data.modelSetId},
                        },
                        "upsert": True,
                    }
                }
            )

        projection = resolve_identity_projection(
            [snapshot.model_dump() for snapshot in data.profileSnapshots],
            evaluations,
            annotations.get(str(segment["_id"])),
        )
        resolution_counts[projection["resolution"]] += 1
        projection_doc = {
            **projection,
            "modelSetId": data.modelSetId,
            "segmentId": segment["_id"],
            "runId": data.runId,
            "embeddingSpaceId": segment.get("embeddingSpaceId"),
            "originalId": segment.get("original_id", segment.get("original")),
            "start": segment.get("start"),
            "end": segment.get("end"),
            "projectedAt": now,
        }
        projection_operations.append(
            {
                "updateOne": {
                    "filter": {
                        "modelSetId": data.modelSetId,
                        "segmentId": segment["_id"],
                    },
                    "update": {
                        "$set": projection_doc,
                        "$setOnInsert": {"createdAt": now},
                    },
                    "upsert": True,
                }
            }
        )

        # Building and ready sets are deliberately invisible to compatibility
        # readers. Activation can expose only a complete set.
        if model_set.get("status") == "active":
            matched_profile_id = projection.get("profileId")
            matched_context = next(
                (
                    context
                    for context in contexts
                    if context["snapshot"].profileId == matched_profile_id
                ),
                None,
            )
            legacy_state = {
                "identified": "matched",
                "unknown": "rejected",
                "ambiguous": "uncertain",
                "uncertain": "uncertain",
                "unclassified": "uncertain",
            }[projection["resolution"]]
            decision = {
                "state": legacy_state,
                "identityState": projection["resolution"],
                "profileId": (
                    ObjectId(matched_profile_id)
                    if matched_profile_id and ObjectId.is_valid(str(matched_profile_id))
                    else matched_profile_id
                ),
                "candidates": projection["candidates"],
                "modelSetId": data.modelSetId,
                "embeddingSpaceId": segment.get("embeddingSpaceId"),
                "runId": data.runId,
                "evaluatedAt": now,
                "source": projection["source"],
                "validity": "verified",
                "matcherVersion": "profile-prototypes-v3",
            }
            update: dict[str, Any] = {"$set": {"speakerIdentity": decision}}
            if projection["resolution"] == "identified" and matched_context:
                matched_evaluation = next(
                    item
                    for item in projection["candidates"]
                    if item["profileId"] == matched_profile_id
                )
                profile_ref = decision["profileId"]
                update["$set"]["matched_speaker"] = {
                    "profile_id": profile_ref,
                    "name": matched_context["profile"].get("name"),
                    "similarity": round(float(matched_evaluation["score"]), 4),
                    "matched_at": now,
                    "method": "speakerIdentityModelSet",
                    "profile_revision": matched_context["snapshot"].profileRevision,
                    "embedding_space_id": segment.get("embeddingSpaceId"),
                    "calibration_id": matched_context["snapshot"].calibrationId,
                    "model_set_id": data.modelSetId,
                }
            else:
                update["$unset"] = {"matched_speaker": ""}
            compatibility_operations.append(
                {
                    "updateOne": {
                        "filter": {"_id": segment["_id"]},
                        "update": update,
                    }
                }
            )

    if data.campaignId:
        _require_campaign_ownership(data.campaignId, job_id)
    for collection, operations in (
        ("speaker_identity_evaluations", evaluation_operations),
        ("speaker_identity_projections", projection_operations),
        ("diarizations", compatibility_operations),
    ):
        if operations:
            call_resource(
                "mongo",
                {
                    "action": "bulkWrite",
                    "collection": collection,
                    "operations": operations,
                    "options": {"ordered": False},
                },
            )

    has_more_in_partition = len(candidates) > data.limit
    next_partition_index: Optional[int] = None
    next_run_id: Optional[str] = None
    source_changed = False
    reset_cursor = False
    total_segments = sum(
        int(partition["sourceSegments"]) for partition in data.partitions
    )
    cumulative_processed = int(campaign.get("processedSegments", 0))
    campaign_processed = min(total_segments, cumulative_processed + len(segments))
    remaining = max(total_segments - campaign_processed, 0)
    if has_more_in_partition:
        status = "running"
    elif data.partitionIndex + 1 < len(data.partitions):
        next_partition_index = data.partitionIndex + 1
        next_run_id = str(data.partitions[next_partition_index]["runId"])
        reset_cursor = True
        status = "running"
    else:
        remaining, first_incomplete, overfilled = _model_set_remaining(data)
        campaign_processed = total_segments - remaining
        if overfilled:
            source_changed = True
            status = "source_changed"
        elif remaining > 0 and first_incomplete is not None:
            next_partition_index = first_incomplete
            next_run_id = str(data.partitions[first_incomplete]["runId"])
            reset_cursor = True
            status = "running"
        else:
            status = "completed"
    has_more = status == "running"
    cursor = str(segments[-1]["_id"]) if segments else data.cursor
    next_cursor = None if reset_cursor else cursor
    elapsed = max(time.time() - started, 0.0)
    progress = {
        "stage": "identity",
        "modelSetId": data.modelSetId,
        "processed": campaign_processed,
        "batchProcessed": len(segments),
        "total": total_segments,
        "remaining": remaining,
        "hasMore": has_more,
        "campaignStatus": status,
        "sourceChanged": source_changed,
        **resolution_counts,
    }
    if not source_changed:
        model_set_update: dict[str, Any] = {
            "$set": {
                "coverage": {
                    "totalSegments": total_segments,
                    "projectedSegments": total_segments - remaining,
                },
                "coverageSourceSnapshot": data.sourceSnapshot.model_dump(),
                "updatedAt": datetime.now(UTC),
            }
        }
        model_set_filter: dict[str, Any] = {"modelSetId": data.modelSetId}
        if status == "completed" and model_set.get("status") == "building":
            model_set_filter["status"] = "building"
            model_set_filter["sourceSnapshot.membershipRevision"] = (
                data.sourceSnapshot.membershipRevision
            )
            model_set_update["$set"].update(
                {"status": "ready", "readyAt": datetime.now(UTC)}
            )
        call_resource(
            "mongo",
            {
                "action": "updateOne",
                "collection": "identity_model_sets",
                "query": model_set_filter,
                "update": model_set_update,
            },
        )
    progress_callback(progress)
    if data.campaignId:
        _update_campaign(
            data.campaignId,
            {
                "modelSetId": data.modelSetId,
                "profileIds": [item.profileId for item in data.profileSnapshots],
                "sourceSnapshot": data.sourceSnapshot.model_dump(),
                "status": status,
                "active": has_more,
                "currentJobId": job_id,
                "totalSegments": total_segments,
                "processedSegments": campaign_processed,
                "pendingSegments": remaining,
                "identified": int(campaign.get("identified", 0))
                + resolution_counts["identified"],
                "ambiguous": int(campaign.get("ambiguous", 0))
                + resolution_counts["ambiguous"],
                "uncertain": int(campaign.get("uncertain", 0))
                + resolution_counts["uncertain"],
                "unknown": int(campaign.get("unknown", 0))
                + resolution_counts["unknown"],
                "lastCursor": next_cursor,
                "partitionIndex": (
                    next_partition_index
                    if next_partition_index is not None
                    else data.partitionIndex
                ),
                "runId": next_run_id or data.runId,
                "sourceChanged": source_changed,
                "failureReason": (
                    "Projection coverage exceeded the frozen source snapshot"
                    if source_changed
                    else None
                ),
                "finishedAt": None if has_more else datetime.now(UTC),
            },
            owner_job_id=job_id,
        )
    return {
        **progress,
        "cursor": next_cursor,
        "nextRunId": next_run_id,
        "nextPartitionIndex": next_partition_index,
        "advancePartition": reset_cursor,
        "campaignId": data.campaignId,
        "duration": round(elapsed, 2),
        # Legacy continuation consumers still understand these counters.
        "matched": resolution_counts["identified"],
        "rejected": resolution_counts["unknown"],
    }


def _process_legacy_speaker_identity_job(
    job_id: str,
    data: SpeakerIdentityJobData,
    progress_callback: Callable[[Dict[str, Any]], None],
) -> Dict[str, Any]:
    started = time.time()
    profile = get_profile_by_id(data.profileId)
    if not profile:
        raise ValueError(f"Profile not found: {data.profileId}")
    if int(profile.get("revision", 1)) != data.profileRevision:
        raise ValueError("Profile revision changed; create a new identity job")

    calibration = call_resource(
        "mongo",
        {
            "action": "findOne",
            "collection": "speaker_calibrations",
            "query": {"calibrationId": data.calibrationId, "profileId": data.profileId},
        },
    )
    if not calibration or calibration.get("status") != "validated":
        raise ValueError("A validated calibration is required before identity backfill")
    if (
        calibration.get("serverComputed") is not True
        or calibration.get("contractVersion") != "server-computed-v1"
        or calibration.get("computedBy") != "speaker-segments"
    ):
        raise ValueError(
            "Calibration is stale; create it with the current server-computed contract"
        )
    if calibration.get("lifecycleStatus") != "active":
        raise ValueError(
            "Calibration is no longer active; run identity preflight again"
        )
    persisted_evidence_hash = calibration.get("evidenceSnapshotHash")
    if not isinstance(persisted_evidence_hash, str) or not persisted_evidence_hash:
        raise ValueError(
            "Calibration evidence snapshot is missing; recalculate calibration"
        )
    if persisted_evidence_hash != data.evidenceSnapshotHash:
        raise ValueError(
            "Calibration evidence snapshot changed; run identity preflight again"
        )
    classification_policy, max_range_hours = _validated_calibration_policy(
        calibration, data
    )
    _validate_calibration_head_and_evidence(
        profile, calibration, data, classification_policy
    )
    target_precision = float(calibration["targetPrecision"])
    if int(calibration.get("profileRevision", 0)) != data.profileRevision:
        raise ValueError(
            "Calibration does not match the current profile revision; validate a new calibration"
        )
    profile_space = profile.get("embeddingSpaceId")
    if not profile_space or calibration.get("embeddingSpaceId") != profile_space:
        raise ValueError(
            "Calibration does not match the current profile embedding space; validate a new calibration"
        )

    positive = float(calibration["positiveThreshold"])
    negative = float(calibration["negativeThreshold"])
    negative_decision_mode = _validated_negative_decision_mode(calibration, negative)
    recommended_positive_threshold, positive_threshold_source = (
        _validated_positive_threshold_provenance(
            calibration, positive, classification_policy
        )
    )
    allow_legacy = bool(calibration.get("allowLegacyCompatibility", False))
    scoring_strategy = calibration.get("scoringStrategy", "centroid")
    if scoring_strategy not in {
        "centroid",
        "max_prototype",
        "top2_prototype_mean",
    }:
        raise ValueError("Calibration has an unknown profile scoring strategy")
    matcher_version = "profile-prototypes-v3"

    campaign_id = data.campaignId or f"speaker-identity-{job_id}"
    campaign = (
        _require_campaign_ownership(campaign_id, job_id)
        if data.campaignId
        else (
            _campaign_call(
                {
                    "action": "findOne",
                    "collection": "speaker_identity_campaigns",
                    "query": {"campaignId": campaign_id},
                }
            )
            or {}
        )
    )
    base_query = _identity_query(data, classification_policy)
    total_segments = campaign.get("totalSegments", data.campaignTotalSegments)
    count_warning: Optional[str] = None
    if total_segments is None:
        progress_callback(
            {
                "stage": "counting",
                "campaignId": campaign_id,
                "evidenceSnapshotHash": data.evidenceSnapshotHash,
                "message": "Counting speaker embeddings to classify…",
            }
        )
        try:
            counted = call_resource(
                "mongo",
                {
                    "action": "count",
                    "collection": "diarizations",
                    "query": base_query,
                    "options": {"maxTimeMS": 5_000},
                },
            )
            total_segments = int(counted)
        except Exception as exc:
            count_warning = str(exc)
            logger.warning("Speaker identity count unavailable; continuing: %s", exc)

    cumulative_processed = int(campaign.get("processedSegments", 0))
    cumulative_matched = int(campaign.get("matched", 0))
    cumulative_rejected = int(campaign.get("rejected", 0))
    cumulative_uncertain = int(campaign.get("uncertain", 0))
    cumulative_skipped = int(campaign.get("incompatibleSkipped", 0))
    rate_samples = [
        float(value)
        for value in campaign.get("rateSamples", [])[-9:]
        if value is not None and float(value) > 0
    ]
    job_ids = [str(value) for value in campaign.get("jobIds", [])]
    if job_id not in job_ids:
        job_ids.append(job_id)
    batch_number = len(job_ids)
    estimated_batches = (
        max(batch_number, math.ceil(int(total_segments) / data.limit))
        if total_segments is not None and int(total_segments) > 0
        else batch_number
    )
    _update_campaign(
        campaign_id,
        {
            "campaignId": campaign_id,
            "mode": campaign.get("mode", data.campaignMode or "classify_existing"),
            "runId": data.runId,
            "partitionIndex": data.partitionIndex,
            **({"partitions": data.partitions} if data.partitions else {}),
            **({"snapshotCutoff": data.snapshotCutoff} if data.snapshotCutoff else {}),
            "profileId": data.profileId,
            "profileName": profile.get("name"),
            "profileRevision": data.profileRevision,
            "calibrationId": data.calibrationId,
            "evidenceSnapshotHash": data.evidenceSnapshotHash,
            "classificationPolicy": classification_policy,
            "decisionValidity": (
                "verified" if classification_policy == "full" else "provisional"
            ),
            "targetPrecision": target_precision,
            "maxRangeHours": max_range_hours,
            "negativeDecisionMode": negative_decision_mode,
            "recommendedPositiveThreshold": recommended_positive_threshold,
            "positiveThresholdSource": positive_threshold_source,
            "scoringStrategy": scoring_strategy,
            "range": {"start": data.start, "end": data.end},
            "status": "running",
            "active": True,
            "totalSegments": total_segments,
            "totalEstimated": total_segments is None,
            "countWarning": count_warning,
            "processedSegments": cumulative_processed,
            "matched": cumulative_matched,
            "rejected": cumulative_rejected,
            "uncertain": cumulative_uncertain,
            "incompatibleSkipped": cumulative_skipped,
            "currentJobId": job_id,
            "firstJobId": campaign.get("firstJobId", job_id),
            "jobIds": job_ids,
            "batchNumber": batch_number,
            "estimatedBatches": estimated_batches,
            "startedAt": campaign.get("startedAt", datetime.now(UTC)),
        },
        owner_job_id=job_id if data.campaignId else None,
    )

    query = dict(base_query)
    if data.cursor:
        query["_id"] = {"$gt": ObjectId(data.cursor)}

    candidates = (
        call_resource(
            "mongo",
            {
                "action": "find",
                "collection": "diarizations",
                "query": query,
                "options": {"sort": {"_id": 1}, "limit": data.limit + 1},
            },
        )
        or []
    )
    segments = candidates[: data.limit]

    operations = []
    counts = {"matched": 0, "rejected": 0, "uncertain": 0}
    incompatible_skipped = 0
    for segment in segments:
        segment_space = segment.get("embeddingSpaceId")
        profile_space = profile.get("embeddingSpaceId")
        if segment_space != profile_space or (
            segment_space in UNKNOWN_SPACES and not allow_legacy
        ):
            incompatible_skipped += 1
            continue
        score = _profile_score(segment["embedding"], profile, scoring_strategy)
        state = classify_identity(
            score,
            positive_threshold=positive,
            negative_threshold=negative,
            negative_decision_mode=negative_decision_mode,
            segment_space=segment_space,
            profile_space=profile_space,
            allow_legacy_compatibility=allow_legacy,
        )
        counts[state] += 1
        rounded_score = round(score, 6)
        identity_state = {
            "matched": "identified",
            "rejected": "unknown",
            "uncertain": "uncertain",
        }[state]
        candidate = {
            "profileId": profile["_id"],
            "name": profile.get("name"),
            "score": rounded_score,
            "profileRevision": data.profileRevision,
            "calibrationId": data.calibrationId,
        }
        decision_validity = (
            "verified" if classification_policy == "full" else "provisional"
        )
        decision = {
            "state": state,
            "identityState": identity_state,
            "primaryScore": rounded_score,
            "topCandidate": candidate,
            "candidates": [candidate],
            "topTwoMargin": None,
            "thresholds": {
                "positive": positive,
                "negative": negative,
                "negativeDecisionMode": negative_decision_mode,
                "recommendedPositiveThreshold": recommended_positive_threshold,
                "positiveThresholdSource": positive_threshold_source,
                "evidenceSnapshotHash": data.evidenceSnapshotHash,
            },
            "profileId": profile["_id"] if state == "matched" else None,
            "profileRevision": data.profileRevision,
            "embeddingSpaceId": segment_space,
            "matcherVersion": matcher_version,
            "calibrationId": data.calibrationId,
            "runId": data.runId,
            "evaluatedAt": datetime.now(UTC),
            "source": "automatic",
            "validity": decision_validity,
            "classificationPolicy": classification_policy,
            "maxRangeHours": max_range_hours,
            "negativeDecisionMode": negative_decision_mode,
            "recommendedPositiveThreshold": recommended_positive_threshold,
            "positiveThresholdSource": positive_threshold_source,
            "scoringStrategy": scoring_strategy,
            "calibrationContractVersion": calibration["contractVersion"],
        }
        compatibility = None
        if state == "matched" and classification_policy == "full":
            compatibility = {
                "profile_id": profile["_id"],
                "name": profile.get("name"),
                "similarity": round(score, 4),
                "matched_at": datetime.now(UTC),
                "method": "speakerIdentity",
                "profile_revision": data.profileRevision,
                "embedding_space_id": segment_space,
                "calibration_id": data.calibrationId,
            }
        update: Dict[str, Any] = {"$set": {"speakerIdentity": decision}}
        if compatibility:
            update["$set"]["matched_speaker"] = compatibility
        else:
            update["$unset"] = {"matched_speaker": ""}
        update_filter: Dict[str, Any] = {"_id": segment["_id"]}
        if classification_policy == "pilot":
            update_filter["$nor"] = [
                {"speakerIdentity.validity": "verified"},
                {"speakerIdentity.classificationPolicy": "full"},
            ]
        operations.append({"updateOne": {"filter": update_filter, "update": update}})

    if operations:
        if data.campaignId:
            _require_campaign_ownership(campaign_id, job_id)
        call_resource(
            "mongo",
            {
                "action": "bulkWrite",
                "collection": "diarizations",
                "operations": operations,
            },
        )

    processed = len(segments)
    cursor = str(segments[-1]["_id"]) if segments else data.cursor
    campaign_processed = cumulative_processed + processed
    campaign_matched = cumulative_matched + counts["matched"]
    campaign_rejected = cumulative_rejected + counts["rejected"]
    campaign_uncertain = cumulative_uncertain + counts["uncertain"]
    campaign_skipped = cumulative_skipped + incompatible_skipped
    elapsed = max(time.time() - started, 0.0)
    batch_rate = processed / elapsed if processed > 0 and elapsed > 0 else None
    final_rate_samples = (rate_samples + ([batch_rate] if batch_rate else []))[-10:]
    smoothed_rate = _rate_estimate(final_rate_samples)
    remaining: Optional[int] = (
        max(int(total_segments) - campaign_processed, 0)
        if total_segments is not None
        else None
    )
    has_more_in_partition = len(candidates) > data.limit
    next_run_id: Optional[str] = None
    next_partition_index: Optional[int] = None
    advance_partition = False
    source_changed = False
    if has_more_in_partition:
        has_more = True
        status = "running"
    elif data.partitions and data.partitionIndex + 1 < len(data.partitions):
        next_partition_index = data.partitionIndex + 1
        next_run_id = str(data.partitions[next_partition_index]["runId"])
        advance_partition = True
        has_more = True
        status = "running"
    elif data.partitions:
        actual_remaining = 0
        first_remaining_partition: Optional[int] = None
        for index, partition in enumerate(data.partitions):
            partition_data = data.model_copy(
                update={
                    "runId": str(partition["runId"]),
                    "partitionIndex": index,
                    "cursor": None,
                }
            )
            partition_remaining = int(
                call_resource(
                    "mongo",
                    {
                        "action": "count",
                        "collection": "diarizations",
                        "query": _identity_query(partition_data, classification_policy),
                        "options": {"maxTimeMS": 10_000},
                    },
                )
                or 0
            )
            actual_remaining += partition_remaining
            if partition_remaining > 0 and first_remaining_partition is None:
                first_remaining_partition = index
            actual_source = int(
                call_resource(
                    "mongo",
                    {
                        "action": "count",
                        "collection": "diarizations",
                        "query": _source_query_for_partition(data, partition),
                        "options": {"maxTimeMS": 10_000},
                    },
                )
                or 0
            )
            if actual_source != int(partition.get("sourceSegments", actual_source)):
                source_changed = True
        remaining = actual_remaining
        if source_changed:
            has_more = False
            status = "source_changed"
        elif actual_remaining > 0 and first_remaining_partition is not None:
            next_partition_index = first_remaining_partition
            next_run_id = str(data.partitions[first_remaining_partition]["runId"])
            advance_partition = True
            has_more = True
            status = "running"
        else:
            has_more = False
            status = "completed"
    else:
        has_more = has_more_in_partition
        status = (
            "running"
            if has_more
            else ("completed" if remaining in (None, 0) else "source_changed")
        )
    eta_seconds = (
        remaining / smoothed_rate
        if remaining is not None and remaining > 0 and smoothed_rate
        else 0.0
        if remaining == 0
        else None
    )
    next_cursor = None if advance_partition else cursor
    _update_campaign(
        campaign_id,
        {
            "status": status,
            "active": has_more,
            "processedSegments": campaign_processed,
            "pendingSegments": remaining,
            "matched": campaign_matched,
            "rejected": campaign_rejected,
            "uncertain": campaign_uncertain,
            "incompatibleSkipped": campaign_skipped,
            "currentJobId": job_id,
            "lastCursor": next_cursor,
            "partitionIndex": (
                next_partition_index
                if next_partition_index is not None
                else data.partitionIndex
            ),
            "runId": next_run_id or data.runId,
            "segmentsPerSecond": smoothed_rate or batch_rate,
            "currentSegmentsPerSecond": batch_rate,
            "etaSeconds": eta_seconds,
            "rateSamples": final_rate_samples,
            "finishedAt": datetime.now(UTC) if not has_more else None,
            "sourceChanged": source_changed,
        },
        owner_job_id=job_id if data.campaignId else None,
    )
    progress_callback(
        {
            "stage": "identity",
            "campaignId": campaign_id,
            "evidenceSnapshotHash": data.evidenceSnapshotHash,
            "classificationPolicy": classification_policy,
            "decisionValidity": (
                "verified" if classification_policy == "full" else "provisional"
            ),
            "targetPrecision": target_precision,
            "maxRangeHours": max_range_hours,
            "negativeDecisionMode": negative_decision_mode,
            "recommendedPositiveThreshold": recommended_positive_threshold,
            "positiveThresholdSource": positive_threshold_source,
            "scoringStrategy": scoring_strategy,
            "batchNumber": batch_number,
            "estimatedBatches": estimated_batches,
            "processed": campaign_processed,
            "total": total_segments,
            "remaining": remaining,
            "matched": campaign_matched,
            "rejected": campaign_rejected,
            "uncertain": campaign_uncertain,
            "incompatibleSkipped": campaign_skipped,
            "segmentsPerSecond": smoothed_rate or batch_rate,
            "etaSeconds": eta_seconds,
            "etaConfidence": "medium" if len(final_rate_samples) >= 5 else "low",
        }
    )
    return {
        "processed": processed,
        "hasMore": has_more,
        "cursor": next_cursor,
        "nextRunId": next_run_id,
        "nextPartitionIndex": next_partition_index,
        "advancePartition": advance_partition,
        "campaignStatus": status,
        "campaignId": campaign_id,
        "evidenceSnapshotHash": data.evidenceSnapshotHash,
        "classificationPolicy": classification_policy,
        "decisionValidity": (
            "verified" if classification_policy == "full" else "provisional"
        ),
        "targetPrecision": target_precision,
        "maxRangeHours": max_range_hours,
        "negativeDecisionMode": negative_decision_mode,
        "recommendedPositiveThreshold": recommended_positive_threshold,
        "positiveThresholdSource": positive_threshold_source,
        "scoringStrategy": scoring_strategy,
        "batchNumber": batch_number,
        "estimatedBatches": estimated_batches,
        "incompatibleSkipped": incompatible_skipped,
        **counts,
        "campaignProcessed": campaign_processed,
        "campaignMatched": campaign_matched,
        "campaignRejected": campaign_rejected,
        "campaignUncertain": campaign_uncertain,
        "campaignIncompatibleSkipped": campaign_skipped,
        "campaignTotal": total_segments,
        "campaignRemaining": remaining,
        "duration": round(elapsed, 2),
    }


def process_speaker_identity_job(
    job_id: str,
    data: SpeakerIdentityJobData,
    progress_callback: Callable[[Dict[str, Any]], None],
) -> Dict[str, Any]:
    """Dispatch new model-set payloads without changing the legacy contract."""
    if data.modelSetId:
        return _process_model_set_speaker_identity_job(job_id, data, progress_callback)
    return _process_legacy_speaker_identity_job(job_id, data, progress_callback)
