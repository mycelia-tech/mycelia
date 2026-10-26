# Thirty-minute live windows for one Omi capture

The 30-minute WLK verification is a tested duration, not an existing server
limit. The Omi rotation overlay creates planned 1800-second live windows to
bound the heavy server-side transcript history while a longer recording
continues. A conversation lasting about an hour can span two windows.

## Recording and transcript contract

The `/v4/listen` connection, Opus decoder, capture ID and WAV writer stay open.
Omi writes decoded PCM to the capture before feeding live preview. Only the
internal live-preview connection is replaced. A normal rollover does not finish
the WAV or create a new final-transcription job.

The boundary is counted from PCM samples actually sent to the provider:
28,800,000 mono samples at 16 kHz. A crossing frame is split on a complete
sample, with its remainder retained in order. There is no intentional overlap,
replay or deletion of audio at a successful planned boundary.

The old window receives binary EOF and must acknowledge `ready_to_stop`.
Its final transcript revisions are retained before the next window starts.
Any remaining hypothesis keeps its draft flag; EOF does not make it confirmed.
Full replacement snapshots keep one capture-wide `preview_id`, monotonically
increasing revision, stable window-qualified row IDs and the previous text.
New timestamps receive the exact sample offset of their window; network waits
do not shift the recording's audio timeline.

## Tradeoffs

- Text can pause while the old window drains and the next one starts. Audio
  continues into the bounded preview queue and the WAV. The measured handoff
  latency must be reported separately from normal first-text latency.
- Whisper's live context restarts. A word or phrase crossing the boundary can
  be less accurate even if every PCM sample is preserved. Final transcription
  of the complete WAV remains independent of the preview windows.
- Sortformer starts a new speaker history. Speaker numbers from separate
  windows are not evidence of the same human. The overlay assigns fresh
  anonymous IDs across windows; the same person may appear under a new number.
  The limit remains four anonymous speakers per window; overlapping speech
  remains limited.
  Named identity and matching people across windows are separate capabilities.
- The WLK history is limited to a window. Omi still retains the combined text
  for the current capture, so one never-ending recording does not have bounded
  transcript memory or snapshot size. The intended workload is conversations
  around one hour, not a claim of indefinite client-memory retention. The
  current selected file-transcription path accepts captures up to four hours;
  leaving a single capture open all day also needs capture-file segmentation,
  independently of rotating live WLK windows. Mono PCM16 at 16 kHz consumes
  about 115 MB of WAV storage per recorded hour.

## Bounded handoff and failure

The preview queue remains limited to 60 seconds of PCM (1,920,000 bytes). A
single 50-second handoff budget covers old EOF drain, socket cleanup and new
provider configuration; these waits must not each consume an independent
full timeout. Cleanup aborts a stalled transport and remains bounded. At an
exact window boundary, the sender waits for the next PCM or Stop first: a
pause does not consume the handoff budget or create an empty next window.

User Stop has a separate 120-second preview-finish limit so Stop during a
handoff can drain the buffered tail. Existing Omi teardown waits for preview
before finalizing the capture metadata, so a stalled provider can delay the
final job until that limit. It does not prevent PCM already written to the
capture from being retained.

A failed EOF, exhausted handoff budget, invalid protocol or full queue must
report degraded live preview. The WAV remains the canonical recording.
The current provider protocol does not acknowledge each PCM frame, so an
unexpected network outage cannot be repaired with guaranteed exactly-once
live replay. This overlay must not silently retry uncertain audio or present
partial preview as a complete final transcript.

## Verification boundary

Fast tests must cover several windows, exact PCM preservation, final revisions,
prefix retention, timestamp offsets, unique speaker namespaces, EOF races,
Stop at/around a boundary, cancellation and bounded failure. A deployment is
not accepted solely because these tests or a health check pass: a real paced
61-minute Docker Omi recording must cross both 30-minute boundaries, retain a
single complete WAV, and complete its normal final-transcription job. Physical
pendant/Bluetooth operation requires a separate device test.

The deployed r7 image passed 48 image-level tests and a 15-minute diagnostic.
The first r6 replay had lost live preview around 700 seconds, before a rollover;
its complete 880.6-second WAV matched independently decoded PCM and completed
a fresh final file job. r7 adds redacted diagnostics without changing that
failure behavior.

The later r7 replay reached one successful rollover at 1800 seconds, retained
its earlier transcript and absolute timestamps, then stopped on `stt_failed`
after **2481.9 seconds** of audio. The first text after the rollover arrived in
**8.221 seconds**; that is measured handoff delay, above the 5-second guide.
The exact captured WAV was verified, but the full 61-minute live/final-job
acceptance did not pass. The second planned rollover was not exercised.
Another long replay is deferred at the user's request. The failure remains
unresolved; a healthy container, an isolated successful rollover or passing
unit tests cannot establish continuous reliability. See the
[follow-up report](../VERIFICATION-2026-10-23-ROTATION.md) for the failed run's
separate live, WAV and final-job evidence, and [README.md](README.md) for the
retained-image build chain, incremental update and rollback procedure.

Preview lifecycle/failure logs live in
`/data/harness/docker/logs/backend.log`, not the container's stdout log. Scope
log reads by container identity and a recorded file offset/inode so older
captures cannot be mistaken for current acceptance evidence.

The Mac must remain awake while it receives the pendant stream and runs Docker.
The verification process uses a scoped `caffeinate -i` assertion; no global
macOS power setting was changed. Sleep in the first run's later observation
period occurred after the stream had already stopped and cannot explain the
earlier ASR failure.
