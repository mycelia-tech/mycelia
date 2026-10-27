# Voice Identity runbook

## Safety model

- Never re-run VAD or STT merely to classify an existing embedding.
- Never match different `embeddingSpaceId` values.
- Never activate a building/failed run.
- Never purge active/building data. Preview first; back up Mongo and verify
  restore before the first physical purge.
- Keep manual labels in `speaker_annotations`; do not rewrite transcript text.

Live and retroactive convenience matching must receive exact embedding
provenance. They compare a segment only with profiles whose `embeddingSpaceId`
equals the admitted route/segment space, and skip automatic matching when that
value is missing or legacy. New `matched_speaker` values record the profile
revision and embedding space used. Older automatic matches without those fields
remain unverified legacy candidates: do not backfill a current revision onto
them, because that would not prove which profile revision made the original
decision.

`matched_speaker` from generic live/retroactive matching is not a calibrated
identity decision. Only a compatible `speakerIdentity` result produced from a
validated calibration is verified. Manual speaker annotations remain
authoritative and are not affected by rebuilding embeddings or calibration.

Current automatic identity is versioned as an **identity model set**. Each set
freezes the included profiles, profile revisions, calibrations, voice-model
space, and source cutoff. A segment is `identified` only when exactly one
profile passes its threshold. If several profiles pass, it is `ambiguous` and
keeps every candidate until a person chooses one. Building/ready sets do not
replace the active set; activation is an explicit, resume-safe final step.

## Bring-up

```bash
docker compose --profile diarization up -d --build diarizator
docker compose exec diarizator curl -fsS http://127.0.0.1:8085/health
docker compose up -d --build backend python-worker frontend
docker compose restart nginx
curl -fkSs https://localhost:4433/readiness
```

The in-network URL for local jobs is `http://diarizator:8085`. Prefer the
container-internal health command above: local IDE/SSH port forwards may also
claim host port 8085 and make `curl localhost:8085` reach a different machine.

The health response must include `modelId`, `modelVersion`,
`diarizationFingerprint`, and `embeddingSpaceId`. Older compatible servers may
omit the compact aliases only when `diarizationFingerprint.model` and
`diarizationFingerprint.resolvedRevision` are present. The backend Jobs health
panel must show the diarizator as healthy before enrollment or re-diarization.

## First migration

Migration `0035_voice_identity_versioning` creates runs, annotations and
calibration collections. It registers existing segments as `legacy-v0` /
`legacy-unknown`, preserving every embedding value.

Verify counts before and after:

```javascript
db.diarizations.countDocuments({ embedding: { $exists: true } });
db.diarizations.countDocuments({
  runId: "legacy-v0",
  embeddingSpaceId: "legacy-unknown",
});
db.diarization_runs.findOne({ runId: "legacy-v0" });
```

Migrations `0066_speaker_review_source_index`,
`0067_speaker_review_range_index`, `0072_voice_identity_campaign_safety`, and
`0073_diarization_run_lifecycle_end_index` keep review, classification
preflight, Timeline aggregation, calibration idempotency, single-campaign
admission, and exact empty-activation repair previews indexed. They are applied
automatically at backend startup.

Migration `0086_speaker_identity_multi_profile_foundation` adds the resumable
identity source index, per-profile evaluations, immutable model sets, active
model-set heads, and Timeline projections. Initial source reconciliation runs
as a bounded job. While it is building, the UI shows **Preparing source N/M**;
it does not run a corpus-wide aggregation from a browser request.

## Selected voice context

Every Voice Identity surface uses the same `profileId` query parameter. The
selection order is URL, last locally selected profile, primary profile, then the
first active profile. Review, Calibration, Jobs, Operations, Timeline, and
Transcript links preserve it. An archived/missing URL profile is reported and
is never silently replaced.

Use **Voice Profiles → Work with this voice** to switch context. Creating a new
profile selects it immediately and opens sample enrollment. Archiving a profile
is a tombstone operation: previewed references, samples, labels, calibrations,
jobs, and historical Timeline identity remain stored; an active primary/model
set/campaign must be resolved first.

## Pilot and backfill

The **Voice identity** card on `/audio/pipeline` shows the primary profile,
current server blockers, and a direct **Open calibration setup** link. Follow
the displayed `label → fit → validate → save → classify` sequence; calibration
reuses stored diarization embeddings and does not rerun audio processing.

1. `/settings/voice-identity`: inspect the Profile card. Rebuild Sky only when
   it says that new clean samples are waiting; sufficient sample volume by
   itself does not require another rebuild.
2. Press **Start recommended review**. The server chooses all compatible active
   recordings with clear speech of at least one second, removes overlapping
   duplicates, mixes recordings, creates a saved stream, and returns the first
   clip in the same response. Source, date, generation, quality, and buffer size
   live under **Advanced**. The default rolling buffer is only for preloading;
   it advances without a batch-complete step. Progress combines usable labels
   from all saved streams.
   - **Sky · clear** creates Timeline identity and a calibration-positive label.
   - **Sky · timeline only** creates Timeline identity but is excluded from
     calibration. Use it for an identifiable hum or clipped word that is not
     good training evidence.
   - **Not Sky / another profile** creates the corresponding manual identity and
     calibration-negative evidence for Sky.
   - **Noise or unclear** records a skip without speaker identity. Use it for
     noise, ambiguous overlap, or an unrecognizable sub-second fragment.
   - **Add clean clip to profile** is different from labeling: use it only for
     clean single-speaker audio. It saves a sample and marks the profile as
     waiting for rebuild; it does not silently rebuild or recalibrate.
   - Use **Edit** to change any saved label or Skip.
   - **Latest saved label** is always visible; **Show all** opens the remaining
     history newest-first. Select any row to listen, correct the speaker, or
     replace the label with Skip.
   - Assigning another speaker remembers it for the next segment. The three
     recently used speakers appear as buttons and shortcuts `1`–`3`; every other
     profile remains in the dropdown.
   - The waveform has one global active player and a visible playhead; changing
     the review segment stops and disposes the previous clip. The next three
     pending clips/groups are fetched into a bounded browser cache, so autoplay
     normally starts without another audio download wait.
   - For targeted work, Advanced can use searchable selected recordings, an
     exact Timeline selection, or one active compatible diarization generation.
     Preview freezes that exact scope for every rolling window.
3. Choose the required independent Check precision and save the calculated
   thresholds. Use `98%` for production, a `95%`/`90%` preset for a provisional
   run, or a custom `90–100%` value in `0.5%` steps. This control is a precision
   policy, not a raw cosine threshold. Values below `98%` require accepting the
   false-match risk and unlock only a job with start/end covering at most 24
   hours. The server accepts only the selected Fit/Check recording IDs and
   recomputes the cosine thresholds and metrics itself; the worker enforces the
   stored policy again when a job starts. If the server cannot prove a safe
   negative threshold, the preview says **Auto not-Sky off · remains uncertain**
   and saves `negativeDecisionMode=uncertain_only`. This is intentional
   Sky-first behavior: automatic Sky matches remain available, but every other
   score is left uncertain instead of being auto-rejected. Manual not-Sky labels
   remain intact. Automatic not-Sky is enabled only when the independent Check
   set also proves the selected precision with at least 20 rejected decisions;
   otherwise the server falls back to `uncertain_only` even if Learn found a
   negative threshold. For a provisional target, **Advanced · stricter automatic
   Sky matching** can raise the positive cosine threshold above the server
   recommendation in `0.005` steps. It can never lower it. A higher threshold
   usually reduces matches, coverage, and recall, but may improve precision. The
   preview marks this as `positiveThresholdSource=operator_stricter`; **Use
   server recommendation**, changing the precision target, or changing the
   Learn/Check split clears the override. This tuning is disabled for production
   because choosing a threshold after seeing Check metrics would contaminate
   independent validation. **Learn** recordings choose the threshold;
   **Independent check** recordings measure it on unseen audio; **Not used**
   keeps labels saved but excludes that recording from the current calculation.
   Recording-role changes recalculate automatically. **Refresh result** repeats
   the same server calculation with the latest labels; it does not save a
   calibration or classify history until the final Save action succeeds. **Wrong
   Sky results** opens the exact held-out clips behind the metric. A corrected
   label triggers a fresh preview; a label that is already correct should stay
   unchanged because it indicates a matcher/threshold error. Inside that list,
   **Previous problem** and **Next problem · autoplay** move through the
   held-out clips without closing the editor; the next clip starts playing
   immediately. The recent-speaker shortcuts `1`–`3` remain active after
   clicking the player or an action button, but are intentionally disabled while
   typing in an input. The overall minimum remains 100 labels with at least 40
   Sky and 40 not-Sky. Independently, Check must contain at least 20 Sky labels,
   20 not-Sky labels, and produce at least 20 automatic Sky matches; a single
   correct match at 100% is not enough evidence. The metric cards show Check
   support, Sky precision, false matches, recall, and the number left uncertain.
   Every Edit/undo/skip changes the calibration evidence snapshot, immediately
   makes the old calibration stale, and requires a fresh automatic preview plus
   Save. Saving the same unchanged evidence and parameters is idempotent.
4. With a saved production calibration, press **Classify all compatible
   history** on Voice Identity or Jobs. The server preflight reads actual active
   segments, splits them into compatible run/embedding-space partitions,
   excludes empty generations, freezes a cutoff, and shows segment/batch counts.
   Do not enter run IDs, revisions, calibration IDs, or cursors. A provisional
   calibration remains limited to a bounded 24-hour pilot.
5. Create an **Audit automatic matches** session to inspect old/current matched
   candidates across different recordings; also review uncertain and rejected
   samples.
6. Watch the campaign, not each 1,000-segment job. Continuations are automatic;
   `Next batch queued` needs no manual action. Completion means that actual
   remaining work across every frozen partition is zero. A changed active source
   becomes `source_changed` instead of incorrectly reporting completion. Every
   next batch reserves its stable job ID before enqueue. The maintenance
   watchdog re-enqueues a missing reservation with that same ID after a backend
   crash, and the Python worker refuses to write if another job owns the
   campaign.
7. When the campaign reaches real `remaining=0`, the new model set becomes
   **Ready**. Press **Show results on Timeline**. Until this explicit activation,
   the previous active set remains visible. Timeline then supports **Selected
   voice only**, **Includes selected candidate**, **Ambiguous**, **Uncertain**,
   and **Unclassified**. A solid profile color is an unambiguous/manual match;
   hatching means the selected profile is one of several candidates.
8. After the first full-history campaign completes, every newly completed
   diarization batch triggers a small automatic identity campaign using the same
   current full calibration. The trigger remains disabled before that baseline,
   so it cannot start the initial historical backfill unexpectedly.

For a second profile, repeat the same flow: select/create it, add clean samples,
rebuild, label positives and negatives for that profile, validate, then build a
new model set that contains both frozen profiles. A rebuild invalidates only
that profile's calibration/evaluations; the old active set stays available
until the new set is complete and activated.

Enrollment and profile re-enrollment share a priority admission queue with
diarization. When all diarizator slots are busy, the job remains **Waiting for
diarizator slot** and starts automatically at the next safe batch boundary; the
active model request is never interrupted. Profile rebuild/enrollment runs
before live diarization, generation builds, and historical backfill. Once the
profile job finishes, deferred diarization is admitted automatically. Jobs and
Job Details show the admission priority and waiting state.

Admission is event-driven: completion, failure, cancellation, or creation of a
deferred continuation immediately drains the shared pool in priority/FIFO order.
The 60-second maintenance pass is only a recovery watchdog for missed events.
Backend logs emit structured `[DIARIZATION_ADMISSION]` drain records with
admission wait time and occupied/free slot counts; while backlog exists, all
slots becoming idle for more than a few seconds is a fault signal. After the
priority/FIFO drain, terminal events also trigger ordinary historical work for
any still-free compatible route using BullMQ reservations rather than persisted
waiting counts. The periodic maintenance drain is only a watchdog.

Historical `missing` continuations prefer their previous diarizator but may use
another free route only when `modelId`, `modelVersion`, and `embeddingSpaceId`
match exactly. Enrollment, profile re-enrollment, targeted work, and generation
builds keep strict route affinity. Job routing snapshots and new diarization
segments store the runtime contract; enrollment and re-enrollment also store it
on the speaker profile. The worker compares the actual inference response with
the admitted contract before saving. Migration
`0069_diarizator_runtime_provenance` records the verified historical model
revision on existing segments, runs, profiles, and diarizator jobs. Existing job
routes on `8085` keep the legacy embedding space, while `8086`–`8090` and `8185`
use the current compatible space; local URLs whose exact embedding runtime is
not provable receive the model revision without a fabricated embedding space.

Absence of `speakerIdentity` means not evaluated. After evaluation, every
eligible segment is `matched`, `rejected` or `uncertain`. Automatic decisions
whose calibration is missing or stale remain stored for audit, but are shown as
unclassified on Timeline/Transcript and counted under `stale decisions`, not as
verified results.

## Re-diarization

`Re-diarize range` creates a building run from already VAD-qualified chunks. It
does not clear `diarized_at` and does not change active Timeline data. When the
bounded chain finishes, the run becomes ready.

Use `Compare` before `Activate`. Activation writes the new active segments
first, then supersedes only overlapping old segments. A retained superseded run
can be activated again as rollback.

Activation is fail-closed when the target generation is empty, still building,
contains unresolved generation errors, or overlaps a running identity campaign.
It records the exact replaced run IDs before changing lifecycle state.

### Repair an accidental empty activation

Open **Voice Identity → Operations & generations → Coverage repair**. Preview is
read-only and reports the empty active generation, exact recoverable segment
count, predecessor runs, and preserved data. It never deletes audio,
transcripts, embeddings, or segment documents.

Only after checking those counts, enter the exact displayed confirmation
`REPAIR <runId> <count>`. The resume-safe repair claims the activation, restores
the proven predecessor segments and run metadata, clears partial supersession
markers, and marks the empty target `failed: Empty activation repaired`. If any
newer competing active coverage exists or provenance is missing, automatic
repair stays blocked for manual investigation.

## Purge

Use `Preview purge`; compare document/embedding counts with the intended run.
Enter the exact string `PURGE <runId> <document-count>`. Preview and execution
use the same lifecycle predicate and execution rechecks the preview under the
activation lock. Only superseded/failed, non-active diarization documents are
deleted. Audio, chunks, transcripts, profiles and annotations remain.

## Verification

Follow `DEVELOPMENT.md` readiness diagnostics: confirm bind mounts and the
effective runtime mode. Live source reload requires `APP_MODE=dev`;
`APP_MODE=prod` requires explicit rebuild/recreation. Verify `[READY]` logs,
container health, `/audio/pipeline`, `/settings/voice-identity`, `/timeline`,
`/transcript`, and a real annotation round-trip.
