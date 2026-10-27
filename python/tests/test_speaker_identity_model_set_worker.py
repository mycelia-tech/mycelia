from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from bson import ObjectId

from jobs.speaker_identity import (
    SpeakerIdentityJobData,
    _latest_annotations_by_segment,
    _model_set_segment_query,
    process_speaker_identity_job,
)

SOURCE_SNAPSHOT = {
    "buildId": "source-build-7",
    "revision": 7,
    "membershipRevision": 3,
}


def _snapshot(profile_id: ObjectId, name: str) -> dict:
    return {
        "profileId": str(profile_id),
        "profileRevision": 3,
        "calibrationId": f"cal-{name.lower()}",
        "embeddingSpaceId": "voice-space",
        "evidenceSnapshotHash": f"evidence-{name.lower()}",
    }


def _profile(profile_id: ObjectId, name: str, embedding: list[float]) -> dict:
    return {
        "_id": profile_id,
        "name": name,
        "embedding": embedding,
        "revision": 3,
        "embeddingSpaceId": "voice-space",
        "calibrationHeadsInitialized": True,
        "activeCalibrationIds": {"full": f"cal-{name.lower()}"},
        "calibrationEvidenceRevision": 0,
    }


def _calibration(name: str) -> dict:
    return {
        "status": "validated",
        "serverComputed": True,
        "contractVersion": "server-computed-v1",
        "computedBy": "speaker-segments",
        "lifecycleStatus": "active",
        "evidenceRevision": 0,
        "evidenceSnapshotHash": f"evidence-{name.lower()}",
        "targetPrecision": 0.98,
        "validationMetrics": {
            "positivePrecision": 1.0,
            "negativePrecision": 1.0,
            "positives": 20,
            "negatives": 20,
            "identified": 20,
            "rejected": 20,
        },
        "profileRevision": 3,
        "embeddingSpaceId": "voice-space",
        "positiveThreshold": 0.8,
        "negativeThreshold": 0.2,
    }


def _run_model_set(
    *,
    second_embedding: list[float],
    source_revision: int = 7,
    membership_revision: int = 3,
    projected_count: int = 1,
    repeats: int = 1,
) -> tuple[list[dict], list[dict]]:
    sky_id = ObjectId()
    belka_id = ObjectId()
    sky = _snapshot(sky_id, "Sky")
    belka = _snapshot(belka_id, "Belka")
    profiles = {
        str(sky_id): _profile(sky_id, "Sky", [1.0, 0.0]),
        str(belka_id): _profile(belka_id, "Belka", second_embedding),
    }
    segment = {
        "_id": ObjectId(),
        "runId": "run-1",
        "embeddingSpaceId": "voice-space",
        "embedding": [1.0, 0.0],
    }
    writes: list[dict] = []
    results: list[dict] = []

    def resource(_name, request):
        collection = request["collection"]
        action = request["action"]
        if collection == "identity_model_sets" and action == "findOne":
            return {
                "modelSetId": "model-set-1",
                "status": "building",
                "profiles": [sky, belka],
                "sourceSnapshot": SOURCE_SNAPSHOT,
            }
        if collection == "identity_model_sets" and action == "updateOne":
            writes.append(request)
            return {"matchedCount": 1, "modifiedCount": 1}
        if collection == "speaker_identity_source_index":
            return {
                "_id": "active",
                "status": "ready",
                "publishedBuildId": "source-build-7",
                "publishedRevision": source_revision,
                "membershipRevision": membership_revision,
            }
        if collection == "speaker_calibrations":
            profile_id = request["query"]["profileId"]
            return _calibration(profiles[profile_id]["name"])
        if collection == "diarizations" and action == "find":
            return [segment]
        if collection == "speaker_annotations" and action == "find":
            return []
        if collection == "speaker_identity_projections" and action == "count":
            return projected_count
        if action == "bulkWrite":
            writes.append(request)
            return {"modifiedCount": len(request["operations"])}
        raise AssertionError(request)

    data = SpeakerIdentityJobData(
        runId="run-1",
        modelSetId="model-set-1",
        profileSnapshots=[sky, belka],
        sourceSnapshot=SOURCE_SNAPSHOT,
        partitions=[
            {
                "runId": "run-1",
                "embeddingSpaceId": "voice-space",
                "sourceSegments": 1,
                "maxSegmentId": str(segment["_id"]),
            }
        ],
        limit=10,
    )
    with (
        patch(
            "jobs.speaker_identity.get_profile_by_id",
            side_effect=lambda profile_id: profiles[profile_id],
        ),
        patch("jobs.speaker_identity.call_resource", side_effect=resource),
    ):
        for _ in range(repeats):
            results.append(
                process_speaker_identity_job("job-1", data, lambda _progress: None)
            )
    return writes, results


def _projection(writes: list[dict]) -> dict:
    request = next(
        item for item in writes if item["collection"] == "speaker_identity_projections"
    )
    return request["operations"][0]["updateOne"]["update"]["$set"]


def test_model_set_one_match_is_identified() -> None:
    writes, results = _run_model_set(second_embedding=[0.0, 1.0])
    projection = _projection(writes)

    assert projection["resolution"] == "identified"
    assert projection["profileId"] is not None
    assert len(projection["candidates"]) == 1
    assert results[0]["campaignStatus"] == "completed"
    assert results[0]["remaining"] == 0
    # A building set remains invisible to legacy diarization readers.
    assert not any(item["collection"] == "diarizations" for item in writes)


def test_model_set_two_matches_are_ambiguous_without_a_winner() -> None:
    writes, _results = _run_model_set(second_embedding=[1.0, 0.0])
    projection = _projection(writes)

    assert projection["resolution"] == "ambiguous"
    assert projection["profileId"] is None
    assert len(projection["candidates"]) == 2


def test_model_set_writes_use_stable_idempotent_upsert_keys() -> None:
    writes, _results = _run_model_set(second_embedding=[0.0, 1.0], repeats=2)
    evaluation_writes = [
        item for item in writes if item["collection"] == "speaker_identity_evaluations"
    ]
    projection_writes = [
        item for item in writes if item["collection"] == "speaker_identity_projections"
    ]

    assert len(evaluation_writes) == 2
    assert len(projection_writes) == 2
    for first, second in zip(
        evaluation_writes[0]["operations"],
        evaluation_writes[1]["operations"],
        strict=True,
    ):
        assert first["updateOne"]["upsert"] is True
        assert first["updateOne"]["filter"] == second["updateOne"]["filter"]
    assert projection_writes[0]["operations"][0]["updateOne"]["upsert"] is True
    assert (
        projection_writes[0]["operations"][0]["updateOne"]["filter"]
        == projection_writes[1]["operations"][0]["updateOne"]["filter"]
    )


def test_model_set_rejects_a_stale_source_snapshot_before_writes() -> None:
    writes, results = _run_model_set(second_embedding=[0.0, 1.0], membership_revision=4)

    assert len(writes) == 1
    assert writes[0]["collection"] == "identity_model_sets"
    assert writes[0]["update"]["$set"]["status"] == "failed"
    assert results[0]["campaignStatus"] == "source_changed"
    assert results[0]["sourceChanged"] is True


def test_model_set_allows_a_refreshed_index_with_same_membership() -> None:
    writes, results = _run_model_set(second_embedding=[0.0, 1.0], source_revision=8)

    assert writes
    assert results[0]["campaignStatus"] == "completed"


def test_automatic_model_set_partition_reads_only_the_append_delta() -> None:
    old_ceiling = ObjectId()
    new_ceiling = ObjectId()
    profile_id = ObjectId()
    data = SpeakerIdentityJobData(
        runId="run-1",
        modelSetId="model-set-active",
        profileSnapshots=[_snapshot(profile_id, "Sky")],
        sourceSnapshot=SOURCE_SNAPSHOT,
        partitions=[
            {
                "runId": "run-1",
                "embeddingSpaceId": "voice-space",
                "eligibleSegments": 4,
                "sourceSegments": 14,
                "afterSegmentId": str(old_ceiling),
                "maxSegmentId": str(new_ceiling),
            }
        ],
    )

    query = _model_set_segment_query(data)

    assert query["_id"] == {"$gt": old_ceiling, "$lte": new_ceiling}


def test_model_set_cursor_exhaustion_does_not_complete_missing_coverage() -> None:
    _writes, results = _run_model_set(second_embedding=[0.0, 1.0], projected_count=0)

    assert results[0]["campaignStatus"] == "running"
    assert results[0]["remaining"] == 1
    assert results[0]["hasMore"] is True
    assert results[0]["advancePartition"] is True


def test_manual_annotation_projects_by_original_and_overlap_after_rediarization() -> (
    None
):
    original_id = ObjectId()
    old_segment_id = ObjectId()
    new_segment_id = ObjectId()
    profile_id = ObjectId()
    start = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
    segment = {
        "_id": new_segment_id,
        "original_id": original_id,
        "start": start,
        "end": start + timedelta(seconds=4),
    }
    annotation = {
        "segmentId": old_segment_id,
        "originalId": original_id,
        "start": start + timedelta(seconds=1),
        "end": start + timedelta(seconds=3),
        "profileId": profile_id,
        "excludedProfileIds": [],
    }

    with patch(
        "jobs.speaker_identity.call_resource",
        return_value=[annotation],
    ):
        projected = _latest_annotations_by_segment([segment])

    assert projected[str(new_segment_id)]["profileId"] == str(profile_id)


def test_manual_projection_keeps_assignment_and_merges_profile_exclusions() -> None:
    segment_id = ObjectId()
    original_id = ObjectId()
    sky_id = ObjectId()
    belka_id = ObjectId()
    andrew_id = ObjectId()
    superseded_profile_id = ObjectId()
    superseded_annotation_id = ObjectId()
    start = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
    segment = {
        "_id": segment_id,
        "original_id": original_id,
        "start": start,
        "end": start + timedelta(seconds=4),
    }
    annotations = [
        {
            "_id": ObjectId(),
            "segmentId": segment_id,
            "originalId": original_id,
            "start": start,
            "end": start + timedelta(seconds=4),
            "profileId": None,
            "excludedProfileIds": [belka_id],
            "supersedesAnnotationId": superseded_annotation_id,
            "updatedAt": start + timedelta(minutes=3),
        },
        {
            "_id": superseded_annotation_id,
            "segmentId": segment_id,
            "originalId": original_id,
            "start": start,
            "end": start + timedelta(seconds=4),
            "profileId": None,
            "excludedProfileIds": [superseded_profile_id],
            "updatedAt": start + timedelta(seconds=30),
        },
        {
            "_id": ObjectId(),
            "segmentId": segment_id,
            "originalId": original_id,
            "start": start,
            "end": start + timedelta(seconds=4),
            "profileId": None,
            "excludedProfileIds": [andrew_id],
            "updatedAt": start + timedelta(minutes=2),
        },
        {
            "_id": ObjectId(),
            "segmentId": segment_id,
            "originalId": original_id,
            "start": start,
            "end": start + timedelta(seconds=4),
            "profileId": sky_id,
            "excludedProfileIds": [],
            "updatedAt": start + timedelta(minutes=1),
        },
    ]

    with patch("jobs.speaker_identity.call_resource", return_value=annotations):
        projected = _latest_annotations_by_segment([segment])

    assert projected[str(segment_id)] == {
        "profileId": str(sky_id),
        "excludedProfileIds": sorted([str(belka_id), str(andrew_id)]),
        "disposition": "speaker",
    }


def test_manual_projection_preserves_noise_and_clear_tombstones() -> None:
    segment_id = ObjectId()
    profile_id = ObjectId()
    start = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
    segment = {
        "_id": segment_id,
        "start": start,
        "end": start + timedelta(seconds=4),
    }
    positive = {
        "_id": ObjectId(),
        "segmentId": segment_id,
        "profileId": profile_id,
        "excludedProfileIds": [],
        "updatedAt": start,
    }
    noise = {
        "_id": ObjectId(),
        "segmentId": segment_id,
        "disposition": "noise_or_unclear",
        "updatedAt": start + timedelta(minutes=1),
    }

    with patch("jobs.speaker_identity.call_resource", return_value=[noise, positive]):
        projected = _latest_annotations_by_segment([segment])
    assert projected[str(segment_id)]["disposition"] == "noise_or_unclear"

    clear = {
        "_id": ObjectId(),
        "segmentId": segment_id,
        "disposition": "clear",
        "updatedAt": start + timedelta(minutes=2),
    }
    with patch(
        "jobs.speaker_identity.call_resource",
        return_value=[clear, noise, positive],
    ):
        projected = _latest_annotations_by_segment([segment])
    assert str(segment_id) not in projected
