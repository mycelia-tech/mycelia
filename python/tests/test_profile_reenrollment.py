from pathlib import Path
from sys import path
from unittest.mock import patch

from bson import ObjectId

path.insert(0, str(Path(__file__).resolve().parents[1]))

from jobs.profile_reenrollment import (  # noqa: E402
    ProfileReenrollmentJobData,
    process_profile_reenrollment_job,
)


def test_rebuilds_profile_in_one_embedding_space() -> None:
    profile_id = ObjectId()
    samples = [
        {
            "_id": ObjectId(),
            "metadata": {
                "source": "review_selection",
                "source_original_id": "recording-1",
                "source_start": "2026-08-10T10:00:00.000Z",
                "source_end": "2026-08-10T10:00:12.500Z",
            },
        },
        {"_id": ObjectId(), "metadata": {"source": "microphone"}},
    ]
    writes = []
    resource_calls = []

    def resource(name, request):
        resource_calls.append((name, request))
        if request["action"] == "find":
            return samples
        writes.append(request)
        return {"matchedCount": 1}

    embeddings = iter(
        [
            {
                "embedding": [1.0, 0.0],
                "duration": 3.0,
                "embeddingSpaceId": "space-v1",
                "modelId": "diar-v1",
                "modelVersion": "rev-1",
            },
            {
                "embedding": [0.8, 0.2],
                "duration": 4.0,
                "embeddingSpaceId": "space-v1",
                "modelId": "diar-v1",
                "modelVersion": "rev-1",
            },
        ]
    )
    with (
        patch(
            "jobs.profile_reenrollment.get_profile_by_id",
            return_value={"_id": profile_id, "revision": 1},
        ),
        patch("jobs.profile_reenrollment._get_audio_from_gridfs", return_value=b"wav"),
        patch(
            "jobs.profile_reenrollment._extract_embedding",
            side_effect=lambda _audio, **_kwargs: next(embeddings),
        ),
        patch("jobs.profile_reenrollment.call_resource", side_effect=resource),
    ):
        result = process_profile_reenrollment_job(
            "job-1",
            ProfileReenrollmentJobData(profileId=str(profile_id)),
            lambda _progress: None,
        )

    assert result["profileRevision"] == 2
    update_request = next(
        request for request in writes if request["action"] == "updateOne"
    )
    update = update_request["update"]["$set"]
    assert update["embeddingSpaceId"] == "space-v1"
    assert update["sample_count"] == 2
    assert update["runtimeProvenance"] == {
        "modelId": "diar-v1",
        "modelVersion": "rev-1",
        "embeddingSpaceId": "space-v1",
        "source": "inference_response",
    }
    assert update["embeddingPrototypes"][0]["provenance"] == {
        "kind": "timeline_interval",
        "source": "review_selection",
        "originalId": "recording-1",
        "interval": {
            "start": "2026-08-10T10:00:00.000Z",
            "end": "2026-08-10T10:00:12.500Z",
        },
    }
    assert update["embeddingPrototypes"][1]["provenance"] == {
        "kind": "saved_voice_sample",
        "source": "microphone",
    }
    assert ("speaker-segments", {
        "action": "invalidate-profile-identity-evidence",
        "profileId": str(profile_id),
        "profileRevision": 2,
        "reason": "profile_reenrollment",
    }) in resource_calls


def test_retry_after_profile_write_only_retries_evidence_invalidation() -> None:
    profile_id = ObjectId()
    profile = {
        "_id": profile_id,
        "revision": 4,
        "sample_count": 2,
        "embeddingSpaceId": "space-v1",
        "embeddingPrototypes": [{"isOutlier": False}, {"isOutlier": True}],
        "enrollmentStatus": "ready",
        "enrollmentProvenance": {
            "source": "saved_samples_rebuild",
            "jobId": "job-retry",
        },
    }
    calls = []

    with (
        patch("jobs.profile_reenrollment.get_profile_by_id", return_value=profile),
        patch(
            "jobs.profile_reenrollment._extract_embedding",
            side_effect=AssertionError("embeddings must not be rebuilt"),
        ),
        patch(
            "jobs.profile_reenrollment.call_resource",
            side_effect=lambda name, request: calls.append((name, request)) or {},
        ),
    ):
        result = process_profile_reenrollment_job(
            "job-retry",
            ProfileReenrollmentJobData(profileId=str(profile_id)),
            lambda _progress: None,
        )

    assert result["profileRevision"] == 4
    assert result["sampleOutliers"] == 1
    assert calls == [("speaker-segments", {
        "action": "invalidate-profile-identity-evidence",
        "profileId": str(profile_id),
        "profileRevision": 4,
        "reason": "profile_reenrollment",
    })]
