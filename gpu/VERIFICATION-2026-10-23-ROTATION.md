# Omi rotation follow-up, 2026-10-23

This follows [the shared WLK and Omi r5 verification](VERIFICATION-2026-10-23.md).
It separates the implemented 30-minute preview windows from the unresolved
intermittent live failure. The earlier accepted direct WLK 30-minute replay
does not establish Omi rollover or indefinite operation.

## Deployed scope

Only the Mac Omi application was replaced for this follow-up. The server WLK,
Whisper, live proxy, other Mac containers, ingress and persistent state volume
were retained. The current Omi r7 image includes the r6 rotation implementation
and adds redacted technical failure diagnostics; it does not change r6 failure,
retry or timeout behavior.

| Artifact | Identity |
|---|---|
| Retained r5 base | `sha256:e44327794d5a92f9feed491f09b10e714a713f2d0e49baae3deb8ae5d719d6a9` |
| r6 image | `sha256:dd91ff3a04e03cc3f83aa51a3d3754e2aec827263352c3332f1785b18356a3b8` |
| Current r7 image | `sha256:869d95a72e6471096c44ae989a93fcd4ae9056b017b8dd25dc67b331f9a9e7d8` |
| r7 rotation helper | `e95846195b3ab092ef62877bf21c1b75ca5252085123850267027ba02e0d0481` |
| r7 container | `827f8bcbebc2811a117be467a06652c195a635a5a82f65309487b96c8237cdf1` |

Deployment checked the image, exact helper, the existing `omiloc-docker_state`
volume mounted at `/data`, unchanged ingress/other containers, zero restarts,
healthy state and the actual `Docker runtime ready` message. r7 reached ready in
38.724 seconds. The provider profile returned authenticated 200 and invalid-token
401; selected endpoints remained WLK `:8010/asr` and file Whisper `:8001/v1`,
model `large-v3-turbo`, profile revision 8. Omi runs an image, without a source
bind mount; source edits alone are not live changes.

The source-hash-guarded build uses the retained r5 image, not the dirty Omi
checkout. The actual-image suite passed all 48 tests: 18 rotation, four failure
diagnostic, 17 reconnect and nine retained compatibility checks. Tests had no
network or state volume. Ruff and `git diff --check` passed.

## Failed r6 replay and preserved recording

The first intended 3660-second replay started at 14:37:41 UTC. Live preview
failed around 700 seconds, before any planned rollover; its last committed
audio end was 695.91 seconds. The client observed one protocol error. The
operator stopped the replay at 14:52:22 UTC, preserving 880.6 seconds of audio.
The subsequent SIGINT explains the original runner's `KeyboardInterrupt`
report, not the earlier live failure.

Independent salvage verified:

- One capture/WAV, 44,030 Opus frames, 14,089,600 decoded samples,
  28,179,200 PCM bytes, zero decode errors and exactly 880.6 seconds.
- The retained PCM matches a separately regenerated and decoded input prefix:
  SHA256 `4d83275fef075a0d24dea3fba441485447f9cc045b3c602e46c9e6701b0ac629`.
- The WAV SHA256 is
  `fefbc8ba28051a51ece7b82ed329bd8a5ae0fd9cc634cda4ef864363b0f00c3d`.
- The normal final file job completed on attempt one with a fresh artifact,
  235 segments and 2,290 words. Manifest and database provenance matched.

The original failed report and its progress log were preserved; the separately
saved salvage report explicitly keeps `live_acceptance_passed=false`.

There were 176 remote resource samples during the exact capture interval.
Whole-device VRAM ranged from 6,197 to 6,620 MiB out of 24,564 MiB. WLK's Docker
working set was 1,956.864–1,975.296 MiB, with 15.36 MiB first-to-last growth.
All sampled WLK health responses were ready (maximum 8.7 ms). Both scheduler
queue depths were zero at the sampled instants; no sample had more than one
running Whisper GPU operation. These samples do not exclude short unsampled
spikes. Qwen was sleeping and file diarization was stopped, so this is not the
peak footprint of every feature enabled simultaneously.

After the user unlocked the local SSH key, a read-only inspection on October
26 recovered the exact r6 diagnostic: `openai.InternalServerError HTTP 502` at
14:49:21.055 UTC, in the remote ASR call through `backends.py:288`. The repeated
`ProcessingFailure` markers log the same exception twice, not two independent
failures. There was no OOM/restart evidence.

Five live-adapter HTTP 502 responses closely followed Whisper HTTP 200 responses
by 1.302–2.099 ms in the checked minute. This suggests a response-handling
failure, but there are no request IDs or adapter branch diagnostics to establish
the original cause. Neither invalid word timestamps, a body-read failure nor
GPU exhaustion is established. The WLK SDK timeout is 15 seconds with one
retry; this is not a total operation deadline. These budgets remain unchanged.

The initially considered Omi timestamp-ordering hypothesis was not silently
patched. The later r7 diagnostic identifies a provider error, rather than that
timestamp-validation path, for its own failure.

Mac idle sleep occurred at 14:58:44 UTC, after the failure and after capture
Stop. It explains the later observation gap, not the earlier live error. The
next tests use `caffeinate -i` only for their own process lifetime; system power
settings were not changed.

## Completed r7 15-minute diagnostic

The next replay sent exactly 900 seconds at real-time pace from about 19:09:40
UTC. There were no protocol errors, snapshot-contract violations, live failure
events or sampled progress stalls above 60 seconds. Two speakers were present
in the final snapshot. One 900-second window acknowledged EOF and the preview
ended with `eof_ack=True`, `failed=False`.

| Measurement | Observed result |
|---|---|
| First text after audio start | 2.828 s |
| First speaker after audio start | about 2.829 s |
| Committed-end progress lag, 493 observations | mean 3.005 s, p95 9.910 s, maximum 28.376 s |
| Maximum full snapshot | 48,543 bytes |
| File requests during live replay | 16 successful, zero failed |
| File-request latency | mean 3.064 s, maximum 4.202 s |
| Final job and import verified within | 39.204 s after Stop |

The lag observations are advances of the maximum committed timestamp, not all
7,331 snapshots or individual words. The final-job duration includes polling
and import confirmation, not just ASR compute time. First-text latency and
committed-text lag are different measurements. The
result does not establish that every committed update arrives within five
seconds, or that every later speaker correction completes within 15 seconds.

The final WAV contains 45,000 Opus frames and 14,400,000 decoded samples, with
zero decode errors and exact input-PCM equality. PCM SHA256:
`bee75df774fd9b80c198a128e659380df9c18264810b99edac62198b89724df5`.
WAV SHA256:
`7800319d8207cd83e9d6ea99ddbef44d48cdb243e3aac4937f2011063685f049`.
The fresh final job completed on attempt one with 239 segments and 2,336 words;
its database provenance matched the capture and manifest.

The frozen v2 verifier initially marked two EOF checks false because it read
container stdout, while preview lifecycle records are in
`/data/harness/docker/logs/backend.log`. A first supplemental parser also missed
the exact `WARNING:utils.local_live_rotation:` and
`WARNING:utils.local_live_preview:` prefixes. Neither original result was
rewritten. The corrected, separately saved supplement verifies log inode,
marker hash, exact container/image, single-capture scope and complete PCM. Its
four checks are true, including EOF and clean preview end; failure diagnostic
count is zero. Thus the 15-minute diagnostic is supported by combined evidence,
not by changing the original verifier's outcome.

The next verifier additionally preserves WAV validation when interrupted during
batch drain, records its log offset before the capture and accepts only the
confirmed bare/prefixed lifecycle formats. Eight focused verifier tests and
independent review passed. Frozen v3 SHA256:
`86ec5905792826fe3a7e35c57a7679679c5fda12980efd93b73b9aff0de05289`.

## Longer r7 replay and October 26 read-only follow-up

The previously started 61-minute replay failed after **2481.9 seconds** of
sent audio (41 minutes 21.9 seconds). It is not a successful hour-long test.
Further long replays were deferred at the user's request on October 26; no
new 60-minute run was started after that instruction.

The first planned rollover did succeed. Window zero acknowledged EOF after
28,800,000 samples, reached committed timestamp 1799.76, and preserved 212
transcript rows in the next window. Window one's first text and speaker label
arrived 8.221 seconds after the boundary, exceeding the five-second text guide.
Both windows retained two speakers. There remained one capture and no decode
or snapshot-contract errors before the provider failure.

At 20:11:46.585 UTC, the redacted r7 diagnostic recorded `provider_error`,
`RuntimeError`, phase `streaming`, window index 1, from `_receive_window:420`.
Omi received a generic error frame from its local provider relay; its own
timestamp-validation path did not raise this error. The relay catches any
exception and emits `live_provider_failed` without preserving the original
cause. An upstream error, transport timeout or relay protocol error therefore
remain possible. The second window did not acknowledge EOF and preview ended
with `failed=True`; the last committed timestamp was 2461.24 seconds.

In the checked server interval, HTTP responses were 200 and no corresponding
`ProcessingFailure` was logged. The last live-adapter 200 preceded the local
relay error by 15.244 seconds. That timing is a correlation, not proof of a
timeout or a remote WLK failure. The available diagnostic identifies the local
relay boundary, not the root cause.

All 42 periodic file requests during live replay succeeded (mean 3.217 s,
maximum 10.382 s). This does not prove that the final full recording job passed.
Committed-end advancement lag had mean 3.253 s, maximum 26.095 s and recent
p95 11.788 s; the p95 covers the last 1,024 of 1,302 advancement observations.
The maximum full transcript snapshot was 128,025 bytes.

The saved WAV is complete for the transmitted prefix: 124,095 Opus packets,
39,710,400 mono samples, 2481.9 seconds, zero decode errors, and exact PCM SHA256
`3319324d02ed83d582db41d96128b90aed2bdd6b296169d9e64b3688647e1403`.
The original report retained the final job as processing when its follow-up
check raised `RuntimeError`. A separate read-only check on October 26 found
that job failed after three attempts, with no completed transcript artifact or
verified database import. Preserve the WAV; do not describe that job as a
successful final transcription or silently retry it as part of documentation.

The original report, anchored diagnostic supplement and exact-image checks
remain separate and unchanged. One successful rollover is established;
complete long-session acceptance and the underlying ASR fix are not. The
operator's decision to commit the implementation is not a new test result.

## User-visible behavior and limits

See [the rotation contract](omi/ROTATION.md). A planned boundary replaces only
the live-preview connection: capture, decoder, WAV and final job remain one.
The completed transcript prefix and absolute sample-based timestamps persist.
There is no intentional replay or deletion of audio at a successful rollover.
Text can pause during handoff; Whisper context and Sortformer speaker history
restart. Each window intentionally assigns fresh anonymous speaker IDs;
cross-window human identity is not inferred. There are at most four speakers
per window, without name recognition. The handoff budget is 50 seconds with a
60-second PCM queue; Stop during a handoff can wait up to 120 seconds for
preview teardown before finalization.

An unexpected transport/ASR failure still reports degraded preview and does
not promise exactly-once replay. WAV preservation is independently verified.
The WLK history is bounded by its window, but Omi retains the capture's combined
transcript. The selected final path validates input WAVs up to four hours,
but that is not proof that a four-hour final job can finish within the
server's 290-second request deadline. The hour-long final job remains to be
measured. Continuous all-day captures require file segmentation as well. PCM16 mono at
16 kHz occupies about 115 MB of WAV storage per hour. The Mac must remain awake
while its Docker application receives the pendant audio. Real pendant,
Bluetooth and phone UI behavior were not exercised by the synthetic replay.

## Evidence and rollback

The user-approved original 62-file verification package was uploaded to the
server release's `verification/` directory and verified against its SHA256
manifest. This new follow-up is preserved locally under
`~/claude-cowork/operations/faeon-wlk-stability-20261023/omi-r7-rotation-followup/`;
it has not been uploaded as part of the older package. Original reports,
corrected supplements and exact runner/source versions remain separate.

Private rendered Compose rollback files are local only, permission 0600, and
excluded from the shareable manifest. Retained r5/r6/r7 images and the existing
state volume allow an idle app-only rollback; do not use `down -v`. No server
model, file-diarization or large-Qwen service was enabled by this follow-up.
