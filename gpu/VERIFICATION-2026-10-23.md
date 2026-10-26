# WLK stability follow-up — 2026-10-23

This report follows the failed September 30 / October 1 soak, which stopped at
369.969 seconds with close code 1011. SSH access now works. That old container
was recreated on October 18, and its failure traceback is no longer available.
The original deployed WLK image passed today's 10-minute baseline, so the
historical exception remains unidentified. The changes below correct verified
code defects; they are not a retrospective attribution of that failure.

## Changes and evidence

- Sortformer inference was synchronous inside an `async` method, including
  CUDA execution and copying predictions to CPU. It now runs in a serialized
  worker, leaving the WebSocket event loop available.
- Cancelling a caller does not cancel its native operation. Cleanup joins
  outstanding ASR and Sortformer operations before releasing the single-session
  slot. Tail padding, inference and timestamp correction stay in one operation.
- ASR and diarization failures retain their original exception and log its
  class, optional HTTP status and traceback locations. Remote response bodies,
  credentials and transcript text are excluded from this added diagnostic.
  Failed processing closes with 1011 and cannot acknowledge successful EOF.
- Request timeouts, retry limits, model, PCM protocol, file API and idle policy
  remain unchanged. No keepalive checks were disabled.
- Ten overlay tests and eight verifier tests pass. They exercise event-loop
  responsiveness, serialized work after cancellation, repeated cleanup
  cancellation, session admission, exact PCM duration and failure reporting.
  Independent review and focused Ruff/whitespace checks passed.

## Verification method

A generated two-voice 45.171-second fixture is repeated in real time from the
Mac to `faeon` over Tailscale. Each file request uses the existing authenticated
`:8001` API with `large-v3-turbo`; the live stream uses authenticated PCM `/asr`
on `:8010`. The 30-minute run includes a file request every 60 seconds and an
8-second reconnect. A separate monitor samples health, scheduler and Docker
working set / GPU device memory every five seconds.

The baseline used the previous verifier, whose short fixture tail slightly
undercounted audio (599.625 seconds in a nominal 600-second run). The corrected
verifier sends exact samples, waits for the final playback interval and reports
client pacing lag. Do not compare that small timing difference as a model gain.

Committed-line lag measures receipt time relative to the line's audio end. It
is not the initial draft-word latency or a measured speaker-refinement delay.
Five-second telemetry cannot prove the absence of sub-sample queue spikes.
Scheduler queues belong to Whisper; WLK has separate unbounded PCM queues,
so these counters alone cannot establish their depth. Live progress/lag is
reported separately.
EOF draining is included in the final lag sample and can inflate its maximum.

## Baseline before replacement

The original image completed 599.625 seconds of audio, emitted two speaker IDs,
acknowledged EOF and passed reconnect. No protocol errors occurred. First text
arrived 3.280 seconds after audio started. All 11 file requests succeeded (mean
3.489 seconds, maximum 7.123 seconds, including Tailnet transfer). Mean
committed-line lag was 3.023 seconds; p95 was 10.128 seconds.

## Patched acceptance

The patched image completed exactly **1800 seconds / 28,800,000 PCM samples**
in real time. All eight acceptance checks passed, including successful EOF and
an eight-second reconnect. There were zero protocol errors and two speaker IDs.

| Measurement | Result |
|---|---:|
| First committed text after audio start | 1.560 s |
| Reconnect first text after audio start | 1.281 s |
| Committed-line lag mean / p95 / max | 2.787 / 8.477 / 24.567 s |
| Concurrent file requests | 31 successful, 0 failed |
| File latency mean / max | 2.909 / 4.846 s |
| Client pacing lag max | 0.052 s |
| Maximum full-snapshot payload | 48,225 bytes |
| WLK container working set min / max | 1.629 / 1.707 GiB |
| Whole-device GPU memory min / max | 5.838 / 6.368 GiB |

There were 363 runtime samples aligned to the verifier interval, all
with healthy/ready WLK. Health latency stayed at or below
26.5 ms. Sampled scheduler maxima were
1 live queued operation,
0 batch queued operations,
2 accepted requests, and
1 running Whisper operation.

Mean committed-line lag by successive five-minute intervals was
2.571, 2.132, 2.903, 3.787, 2.609, 2.86 seconds;
it did not increase steadily through the run. This is not a claim that every
word or speaker refinement stayed below five/fifteen seconds: those specific
per-word/per-turn deadlines were not measured in this follow-up.

WLK working set increased by 79.9 MiB across the sampled
run/reconnect. Full transcript history grows by design; the test does not prove
bounded memory for an indefinite connection. The small Qwen container was
sleeping during acceptance, and file diarization remained stopped. These GPU
figures are not the simultaneous peak with Qwen inference or Pyannote.
One Whisper process and one Sortformer process were confirmed by container/PID
ownership; WLK did not load a second Whisper model.

## Disconnect and silence

The second connection was rejected with code 4409 without sending audio while
the accepted stream continued. Three forced TCP disconnects were followed by successful new session
admission and empty-stream EOF. Measured release/readiness waits were
1.244, 0.405, 0.411 seconds.
No service restart was needed. The empty sessions received `ready_to_stop`;
the existing endpoint returned without a complete WebSocket close handshake
(client transport close code 1006 after the application-level EOF ACK). This
post-EOF transport behavior is distinct from the historical midstream 1011.

A separate session sent 20 seconds of speech, 125 seconds of PCM silence and
20 seconds of speech. All 165 seconds were sent, text resumed, and EOF was
acknowledged without protocol errors. Text after resuming speech arrived in
3.432 seconds. Sampled model-state transitions
(relative to the independent monitor start) were `[(0.0, 'loaded'), (130.0, 'unloaded'), (150.0, 'loading'), (155.0, 'loaded')]`.
The idle test did not change the existing unload timeout.

## Docker Omi software path

The first Mac Omi r4 run sent 240 seconds, returned
2 live speaker IDs and had
0 main-stream protocol errors. Its immediate
eight-second reconnect failed live verification: it reported
1 protocol error(s),
0 live speaker IDs, and no committed live
text. Both WAV captures and their automatic final jobs nevertheless completed.
The original failed report is retained as `omi-software-path.json`; the separate
`omi-software-path-verified.json` corrects only the final-artifact check and
preserves the failed live-reconnect results in `verification`.

The initial checker expected `capture_key` in the manifest and `import.json`.
The deployed r4 importer does not write either field/file. A separate read-only
check selected each current watcher job by its synthetic capture key, matched
the WAV SHA-256 and pinned provider profile to its manifest, and read the exact
saved record derived from `result_key`. Completed database status, exact
`external_data` provenance and segment counts confirmed both imports. The
failed initial live reconnect was not converted into a pass by this correction.

Omi r5 adds a bounded retry for the explicit pre-audio WLK busy response,
sharing a 45-second admission budget across connect, config receipt, cleanup
and backoff. It sends no PCM before a valid provider config; failures after
admission do not replay audio. The existing PCM buffer remains bounded to
60 seconds, and the relay-only handshake wait is 50 seconds. Omi's early
`provider=offline_capture` readiness event describes WAV capture, not proof
that WLK has already accepted the stream.

Seventeen reconnect tests and all nine retained r4 compatibility tests passed
inside the new r5 image with networking disabled and no state volume mounted.
Independent review also checked cancellation, context cleanup and the distinction
between a per-attempt timeout and exhaustion of the total admission budget.

After the r5 app deployment, provider registry revision
8 still selects shared WLK for live audio and
`:8001/v1`, `large-v3-turbo`, for final transcription. The new synthetic CV1
Opus replay sent exactly
240 seconds plus an eight-second reconnect. Both returned live
text, the main stream showed 2 speaker IDs and reconnect
showed 1. There were
0 main-stream and 0
reconnect protocol errors. First text arrived after
1.254 seconds of audio; reconnect first text
after 7.059 seconds.
The immediate reconnect therefore exceeded the original five-second first-text
guide while waiting for the preceding session to drain; this run verifies
recovery and audio preservation, not that all latency targets were met.
Main-stream committed-line lag mean / p95 / max was
5.489 /
19.025 /
28.041 seconds. This is distinct from
the latency of initial draft text or speaker-label refinement.
All 5 concurrent file requests succeeded, with
0 failures. This acceptance uses
`omi-r5-software-path.json`; the previous r4 reports remain separate evidence.

Both captures have exact expected WAV duration/sample counts, zero decoder
errors, completed watcher jobs, matching audio SHA-256/pinned-provider-profile
manifests and verified saved database records. The check requires exact
database provenance and matching nonempty segment counts; it does not require
the newer `capture_key`/`import.json` schema.

| WAV seconds | Samples | Frames | Job attempts | Segments / words | Transcript artifact predates capture |
|---|---:|---:|---:|---:|---|
| 240 | 3840000 | 12000 | 1 | 64 / 627 | True |
| 8 | 128000 | 400 | 1 | 3 / 23 | True |

2 of 2 final transcript artifacts predate their new captures.
An exact repeated synthetic WAV can reuse the matching transcript cache; that
proves the new capture/job and saved result relationship, not another inference
for the cached file. Concurrent multipart requests independently exercised the
file API during this run.

This checks the actual Docker software path and persisted final results, not a
physical wearable or a 30-minute Omi transport run.

## Deployment and rollback

The WLK deployment recreated only `sky-livekit-wlk-1`, after confirming no
established session. Docker health and `/health ready=true` were followed by
real audio. The subsequent Omi reconnect fix recreated only the Mac app
`omiloc-docker-app-1`; its ingress and state volume were preserved. The Omi
receipt identifies container `b703e73e4964bd6d88a8d4f21df364def64a2c59613d77c47e1af8899e942551`, health `healthy` and an
observed runtime-ready event (`ready=True`). The preserved state volume
is `omiloc-docker_state`. The existing Whisper container/process, proxies, stopped
file diarizer and all volumes were preserved. The legacy WLK container remains
stopped.

Deployment root on faeon: `/mnt/datadrive/sky-services/projects/shared-audio`.
The release `releases/20261023-wlk-stability-v2` contains the source overlay,
pinned payload manifest, layer Dockerfile, build/deploy receipts and a private
rollback copy of the canonical WLK Compose. That Compose remains at
`releases/20260930-shared-live-v1/wlk.compose.json`; its WLK image/build target
now refers to the new release. Rendered Compose contains secrets and stays off
Git.

| Role | Image |
|---|---|
| New WLK | `sha256:8b820496f7ce569fe66861289408f5507b7e4eca4a1d788bf06b42176486939c` |
| Previous WLK / rollback | `sha256:e97e8435a028c6b17754a9abd1aeaa18680e26be76f2eef464b9a32052f264c5` |
| Unchanged Whisper | `sha256:6a14dad9718b36e9825ece13ec8b93df05183b8fc13a3c84f6bd9460e9689c4c` |
| Mac Omi r5 (deployment receipt) | `sha256:e44327794d5a92f9feed491f09b10e714a713f2d0e49baae3deb8ae5d719d6a9` |
| Previous Mac Omi r4 / rollback | `sha256:c8b35eacf0c97aac57575be9d714c54a2888bed957fce9ddefc8b728ade8d26f` |

The deployed layer is built from the exact saved previous image. The guarded
upstream overlay remains reproducible from its pinned v0.2.26 source. The new
tag is `sky-whisperlivekit:stability-20261023-v2`; the saved prior image has
`sky-whisperlivekit:rollback-20261023-e97e8435`.

For rollback, wait for the live session to finish, take the existing
`.qwen-switch.lock`, restore the release's private `rollback/wlk.compose.json`
to the canonical Compose and recreate only `wlk` with `--no-deps --no-build`.
Do not run `down -v`, replace Whisper or start the legacy WLK owner.

Mac Omi rollback retains the r4 image shown above and private copies
`omi-rollback/compose.rendered.json` and `omi-rollback/compose.override.yaml`.
Their durable local directory is
`/Users/pk/claude-cowork/operations/faeon-wlk-stability-20261023/omi-rollback`;
they are deliberately excluded from the remote verification archive. The
deployment receipt retains the original temporary paths as deployment evidence.
Restore the prior app image/configuration only after active captures and jobs
finish; recreate only the app and preserve its existing state volume and
ingress. Rendered Compose may contain credentials and stays private. The
Omi image and readiness facts above come from `omi-deployment.json`, not from
the source patch or an assumed tag.

## Limits

A successful bounded replay is evidence for this build and workload, not a
24/7 reliability guarantee. The fixture has two anonymous voices; it does not
revalidate four-speaker, overlap or physical iPhone/CV1 behavior. In default `mode=full`, token/diarization history has unlimited retention,
and the full snapshot is regenerated about every 50 ms. The ASR committed
history also grows until a reset or sufficiently long silence. Transcript
history/snapshots therefore grow with session duration; observed container
memory growth is not, by itself, evidence of a leak. Simply setting finite
retention would discard earlier text from replacement snapshots and change
the current client contract. Truly continuous capture needs a compatible
history/rollover design and a longer acceptance run. A permanently hung native call
intentionally retains admission until process recovery, rather than admitting
another GPU user over unfinished work. The new diagnostics make future
failures inspectable without silently dropping audio or reporting partial
success.

Technical reports, sample monitors and replay scripts are retained privately
under this release’s `verification/` directory. They contain counters and
timing metadata; credentials and transcript text are excluded.
