# Shared audio deployment verification

Historical snapshot. The [October 23 follow-up](VERIFICATION-2026-10-23.md)
records restored SSH access, reliability fixes and a completed 30-minute replay.
The earlier failure and deployment details below are retained as evidence.

Deployment host: `faeon` (`100.119.163.116`). Release directory:
`/home/Skywinder/shared-audio/releases/20260930-shared-live-v1`.

## File API and model

- The original model, `large-v3-turbo`, float16 precision, proxy bearer key,
  port 8001, VAD=false and 100-second idle timeout are preserved.
- The existing `mycelia-stt_whisper-cache` volume is mounted explicitly.
- A generated two-voice PCM recording (45.171 seconds, no personal source audio)
  produced exactly equal JSON before and after the change: text, six segments,
  and 117 words with timings. Baseline: 1.730 seconds on the server. New server:
  1.560 seconds after idle reload, then 0.501 seconds warm.
- Public API checks: missing/wrong key 401; wrong model 409; advertised model
  correct; explicit language and prompt preserved; invalid audio remains an
  error. With the preserved VAD=false, zero audio can produce Whisper text;
  upstream did not guarantee empty output for this setting.
- A request using Mycelia's actual configured URL, key and model, with the same
  multipart fields as its worker and no language/prompt, returned HTTP 200 and
  nonempty text. This did not ingest a record or claim a queued Mycelia job.
- The private adapter returned 117 real words for speech and empty text,
  segments and words for silence with its VAD=true setting.
- Server readiness was confirmed by `[READY]`, Docker health, and real audio.
  Idle unload and subsequent reload were observed. The scheduler reported zero
  active/queued work after completion.

## Deployment and rollback state

- Whisper and public/private proxies run as the existing `mycelia-stt` project.
  Host `/home/Skywinder/mycelia-stt/docker-compose.yml` and Portainer stack 20's
  canonical Compose file contain the same rendered release configuration.
  Rendered files contain credentials and are private; do not copy them to Git.
- `sky-audio` uses `10.250.81.0/28`, checked against Docker networks and all IPv4
  routes. Docker's automatic subnet pool was exhausted; no old network was
  removed.
- WLK's include and app dependency were removed from `omiloc-stack`. Its stopped
  legacy `omiloc-docker-wlk-1` container is retained with `restart=no`.
- The release's private `rollback/` directory retains old Compose/environment
  files, container metadata and Portainer stack 20's original definition. Old
  Whisper, proxy and WLK images and all existing volumes remain available.
- Rollback order: stop the shared WLK, drain the upgraded Whisper, wait for no
  accepted work, stop the private proxy, restore the saved STT definitions and
  restart only Whisper/public proxy with their old images. Keep WLK stopped
  until selecting one owner. Never run both old WLK Compose definitions.
- Local Omi provider state was backed up inside its existing state volume at
  `/data/backups/shared-audio-20260930`. Its old provider cards remain saved.
  The remote final STT and live WLK cards are active (registry revision 8).
  The original ingress and guarded app compatibility image use the
  external-STT Compose overlay; built-in Omi STT stays stopped.

## Live protocol and Omi software path

- WLK is healthy with LocalAgreement, `openai-api`, Sortformer, PCM input and
  0.8-second ASR coalescing. The private ASR URL is explicitly Docker-local.
- Missing WLK authentication returns 403. A second active stream is rejected
  with close code 4409. Config advertises `diarization=true`; an empty stream
  acknowledges EOF with `ready_to_stop`.
- Paced 46-second and 8-second reconnect tests both returned two speaker IDs,
  no protocol errors and EOF acknowledgement. The warm reconnect produced first
  text in 1.857 seconds from connection start and finished in 9.303 seconds.
- A real Docker Omi `/v4/listen` replay used CV1 Opus frames, persisted a 45.98s
  WAV with 2,299 frames and zero decoder errors, and displayed two speaker IDs.
  A repeat produced first committed text 2.832 seconds after audio started,
  zero protocol errors and six normal Omi heartbeats. This proves the software
  path, not a physical device recording or final asynchronous STT completion.
- An independent six-turn, two-voice synthetic replay verified all six final
  turn assignments and all six durable refinements within 15 seconds. Maximum
  delay was 9.960 seconds after sending a turn's end. The calculation uses one
  consistent anonymous-label mapping, final coverage of each turn's one-second
  center, and durable 80% of final labelled coverage. It does not measure four
  simultaneous voices, real speaker identity or overlapping-speech accuracy.
- Omi emits literal `ping` frames. The verifier now treats these as heartbeats,
  retains partial reports on disconnect and fails incomplete-stream acceptance.
  Four regression checks cover heartbeat classification, failed-stream reports,
  reader failures and reconnect errors.
- The r4 Omi compatibility image completed a two-minute paced replay without
  disconnect: 119.942 seconds sent, two speaker labels, 12 heartbeats and zero
  protocol errors. All three simultaneous file requests succeeded (mean 7.289,
  maximum 9.391 seconds, including Mac-to-server transfer). First text arrived
  5.973 seconds after audio started; mean committed-line lag was 2.633 seconds,
  p95 8.923. The subsequent warm 12-second reconnect had zero errors and first
  text after 1.448 seconds of audio. Omi setup took 7.695 seconds on that
  reconnect, so first text from connection start was 9.160 seconds.
  The persisted WAV contains 119.96 seconds (1,919,360 PCM samples), 5,998
  received packets and zero decode errors. Its SHA-256-matched automatic final
  job completed on the first attempt with 33 segments and 320 word entries.
  The reconnect saved exactly 12 seconds, 600 packets and zero decode errors;
  its first-attempt final job produced three segments and 35 word entries.
  Both backend import reports confirm `import=passed`, `created=true`, and the
  matching 33/3 segment counts. The deployed importer fails its exit status on
  persistence failure, and the watcher marks completion only after that step.
  Live snapshots carry two speaker labels; final batch diarization remains
  disabled and its stored segment metadata does not establish two speakers.
- Initial Omi sustained checks hit a client keepalive timeout. Separately, the
  final-STT worker exceeded its hardcoded 60-second backend-import subprocess
  timeout before sending ASR. These are not successful final-job/soak results.
- The direct WLK soak reached 369.969 seconds of audio before one protocol error
  and server close 1011. All seven concurrent file requests completed; client
  latency averaged 8.186 seconds (maximum 22.430, including Tailnet upload).
  Live committed-line lag averaged 4.090 seconds, p95 10.072, maximum 14.537,
  excluding connection setup. This is a failed soak, not a 30-minute pass.
  The underlying server exception still needs its traceback; it must not be
  inferred solely from the WebSocket code. Subsequent short speaker replay
  completed normally, including EOF.

## Images and model ownership

| Service | Image ID |
| --- | --- |
| Shared Whisper | `sha256:4c9c1148b33445be5fcff8b2c7af84cfa383386dd07797158b69f39782325150` |
| Public/private proxy | `sha256:e401649f17fbbdf5b32083103b6533ec24eaab03d3e8b20e60dbb7966c2ae97f` |
| Shared WLK | `sha256:6519e70c4dae6675dd6f9e9648e82e977caa46bf5ece736d6df4b5331cec9875` |
| Local Omi compatibility r4 | `sha256:c8b35eacf0c97aac57575be9d714c54a2888bed957fce9ddefc8b728ade8d26f` |

`nvidia-smi` mapped one Whisper process to `mycelia-stt-whisper-1` (2,558 MiB)
and one Sortformer process to `sky-livekit-wlk-1` (1,406 MiB). The pre-existing
llama process used 444 MiB. The legacy WLK container is stopped; the local Omi
built-in STT container is stopped. No second Whisper is loaded by WLK.

## Validation still in progress

A successful 30-minute soak still requires diagnosis of the server close 1011
and a new full run. New Omi captures now pass automatic final transcription;
the older failed synthetic test history remains intact. Source tests and
configuration alone do not prove sustained performance. No physical iPhone/CV1
test has been performed.

The guarded Omi compatibility image addresses measured import and capture
checkpoint delays plus cold-start readiness failures: infrastructure TCP
listeners now have a bounded 300-second wait; a timed-out Firestore owner read
has a 120-second retry window; the relay health check has a 60-second window.
All original readiness predicates remain required. Measured owner-read attempts
took 8.464 seconds (timeout), 8.114 seconds (200), then 0.166 seconds (200),
showing that an open port does not imply readable imported data. The existing
180-second backend health deadline is unchanged.

Nine isolated, network-free tests cover checkpoint rate, exact final counters,
actual PCM tail recovery, transient/nontransient owner-read failures, stop
handling, all-three-port readiness and bounded relay startup. Independent review
approved the changes. Startup failures retain a traceback and exit code 1.
The r4 app runs with the canonical runtime command and restart policy
`unless-stopped`; the temporary diagnostic override is no longer used. The
readiness monitor observed healthy status plus backend and library HTTP 200
after 57 seconds, with zero restarts. Supervisor logs confirm
`Docker runtime ready` after backend, library and worker startup. The automatic worker holds
its watcher lock. After both replays the same app remained healthy with zero
restarts, and both new final jobs completed automatically. The saved original Omi image is tagged
`sky-omiloc-rollback:20261001-7e0f8fe1` (image `7e0f8fe1ef6d...`). Only the app
container is recreated; the existing state volume and ingress are preserved.

The Mac has 32 GiB physical RAM and a measured 34,255 MiB swap in use out of
34,816 MiB. Docker Desktop has 15.84 GiB available and other running workloads.
This severe host memory pressure limits local cold-start and latency conclusions;
unrelated applications and services were not stopped for these tests.

Server log diagnosis is currently blocked by unavailable SSH authentication
on the Mac; the configured 1Password agent socket is absent. Existing API
tokens and short audio requests still work, but they do not expose the failed
stream's server traceback. A user unlock request is pending; no speculative
server patch has been deployed for close 1011.

Focused source checks total 42 passing tests: scheduler/engine/service 14,
public/private proxy compatibility 9, WLK overlay 6, verifier 4, and isolated
Omi image 9. Ruff and whitespace checks pass. These checks do not replace the
pending sustained-stream acceptance run.
