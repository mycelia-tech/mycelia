from speaker_identification.identity_model_set import resolve_identity_projection


SKY = {
    "profileId": "sky",
    "profileRevision": 6,
    "calibrationId": "sky-calibration",
    "embeddingSpaceId": "voice-space",
}
BELKA = {
    "profileId": "belka",
    "profileRevision": 2,
    "calibrationId": "belka-calibration",
    "embeddingSpaceId": "voice-space",
}


def evaluated(snapshot: dict, state: str, score: float) -> dict:
    return {**snapshot, "state": state, "score": score}


def test_multiple_matches_are_ambiguous_without_a_winner() -> None:
    result = resolve_identity_projection(
        [SKY, BELKA],
        [evaluated(SKY, "matched", 0.91), evaluated(BELKA, "matched", 0.86)],
    )
    assert result["resolution"] == "ambiguous"
    assert result["profileId"] is None
    assert [item["profileId"] for item in result["candidates"]] == ["sky", "belka"]


def test_partial_set_is_unclassified_even_when_first_profile_matches() -> None:
    result = resolve_identity_projection(
        [SKY, BELKA], [evaluated(SKY, "matched", 0.91)]
    )
    assert result["resolution"] == "unclassified"
    assert result["complete"] is False


def test_manual_assignment_wins_but_keeps_automatic_candidates() -> None:
    result = resolve_identity_projection(
        [SKY, BELKA],
        [evaluated(SKY, "matched", 0.91), evaluated(BELKA, "matched", 0.86)],
        {"profileId": "belka", "disposition": "speaker"},
    )
    assert result["resolution"] == "identified"
    assert result["profileId"] == "belka"
    assert result["source"] == "manual_projection"
    assert len(result["candidates"]) == 2
