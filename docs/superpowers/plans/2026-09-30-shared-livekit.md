# Shared WhisperLiveKit Implementation Plan

> Use subagent-driven-development for parallel bounded implementation and independent review.

Goal: Serve one Omi Local live stream with Speaker 1-4 from faeon while preserving Mycelia file transcription, using exactly one resident Whisper model.
Architecture: Existing Whisper v1.9.1 GPU owns large-v3-turbo. A cooperative weighted GPU-operation scheduler preserves per-request generators. WLK v0.2.26 uses remote OpenAI-compatible ASR through an internal authenticated proxy, LocalAgreement and Sortformer. Local Docker Omi uses that shared service.
Spec: User-approved implementation plan in this chat, 2026-09-30.

## Global constraints
- Preserve unrelated checkout changes, existing external volumes, API :8001, model/language/prompt/segment/word behavior and authentication.
- One resident Whisper instance; one live session; at most four anonymous speakers; no WebRTC or named identity.
- GPU scheduling 4 live operations to 1 batch operation when both are waiting; running operation is non-preemptible.
- Preserve native complete-file generator/context. Never split uploaded files into separate ASR requests.
- Bound admission and cleanup cancellations/timeouts. Hold model while accepted work is active/queued/suspended; start idle timeout after last completion.
- Keep secrets in local protected files/environment; do not print them or use cloud fallbacks.
- Remote rollout is authorized by the implementation request. Drain before recreating affected services; preserve rollback images/config and do not restart unrelated services.

## Tasks
1. gpu/whisper_shared: reproducible v1.9.1 overlay with operation scheduler, asynchronous HTTP handling, lifecycle and critical regression tests.
2. gpu/livekit: pinned v0.2.26 image, remote backend adaptation, authenticated one-session PCM protocol with explicit diarization capability, Compose and tests.
3. gpu/proxy: backward-compatible batch route, private authenticated live route and true words flattening. Update Compose wiring/documentation and validation tool.
4. Independent review + offline tests + image build. Resolve findings before deployment.
5. Prepare immutable remote release and backups. Drain/update only Whisper/proxy/WLK. Remove duplicate WLK ownership without deleting data.
6. Configure Docker Omi using existing external providers; verify actual Omi live audio plus simultaneous Mycelia batch and 30-minute soak. Record measured latency and any limits precisely.

## Interfaces
- Whisper accepts internal X-ASR-Priority: live only with X-ASR-Live-Token matching LIVE_ASR_TOKEN; otherwise batch/default. Existing /asr remains compatible. /scheduler reports technical counts without secrets; /health readiness is distinct from model loaded state.
- Proxy public /v1/audio/transcriptions stays unchanged. Separate private live listener :8002 exposes /v1/audio/transcriptions, requires LIVE_ASR_TOKEN and forwards trusted priority; only live response adds top-level words flattened from real segment.words. WLK uses http://live-asr:8002/v1.
- WLK env OPENAI_BASE_URL, OPENAI_API_KEY (LIVE_ASR_TOKEN), WLK_ASR_MODEL=large-v3-turbo, WLK_API_TOKEN; public :8010 bound to Tailscale. Initial config includes diarization=true and stt_provider=whisperlivekit-remote. PCM16 mono 16000, full snapshots, binary EOF and ready_to_stop.

## Validation
- Scheduler tests priority/fairness, bounded admissions, no overlapping GPU ops, cancellation/deadline, generator context and idle unload.
- Proxy tests existing response/auth/model/prompt/word timing, live token separation and real-word flattening.
- WLK tests configuration fail-closed without internal URL, model selection, explicit capability and single-session admission.
- Runtime: real batch before/after; one live concurrent with batch; 2-4 speaker fixture, silence, EOF/reconnect; one Whisper load/owner and GPU memory; 30-minute soak. Targets warm text <=5 s and speaker refinement <=15 s, no growing backlog.

## Progress
- Initial inspection: original checkout contains unrelated Voice Memos changes; isolated worktree created at sky/shared-livekit.
- Plan approval already supplied explicitly by user; no additional design approval is required.

- Task 1 implemented: 14 focused tests; independent review found late-completion deadline gap, fixed with regression. Native CT2 synchronization verified by reviewer.
- Task 3 private API implemented: 9 compatibility/auth/timing tests and Ruff pass. Private listener is separate live-proxy container, alias live-asr on sky-audio network.
- Remote images built and deployed after draining the old proxy. Backup stored in protected remote release; unrelated services and volumes preserved. Portainer stack 20 and host Compose definitions now agree.
- Original two-speaker fixture transfer denied by automatic review for uncertain provenance. Replaced test input with newly synthesized Samantha/Daniel dialogue, provenance saved; original recording not transferred.
- WLK pinned overlay implemented and independently reviewed; 6 tests pass. Real PCM EOF/reconnect and two speaker labels verified. Coalescing 0.8 s prevents tiny VAC frames from causing redundant growing-buffer ASR calls.
- Docker Omi external final/live providers activated. Two short real CV1 Opus software replays produced text and two speaker IDs. Longer Omi replay exposed a keepalive timeout; final worker exposed its existing 60 s import subprocess budget. Sustained direct WLK + batch verification and Omi recovery are in progress; evidence is recorded in gpu/VERIFICATION-2026-10-01.md.
- Verifier counts Omi heartbeat frames correctly and saves failing partial reports; 2 acceptance-report regression tests pass.
- Verifier review added reader-failure and reconnect-error regressions; 4 checks pass. Six-turn synthetic speaker refinement passed 6/6 with maximum durable delay 9.960s. Direct live/batch soak failed at 370s with server close 1011 despite 7/7 file requests succeeding; SSH authentication became unavailable before its traceback could be retrieved.
- A guarded Omi compatibility image under gpu/omi preserves the deployed base and dirty checkout. It addresses measured import timeout, per-packet metadata fsync and cold-start readiness limits; 9 isolated tests and independent review pass. R4 uses the canonical command and restart policy and remains healthy without restarts under severe Mac memory pressure.
- R4 Docker Omi completed a two-minute stream plus warm reconnect without protocol errors. Three concurrent file requests succeeded. Both WAVs match capture counters and have zero decode errors; automatic final jobs completed on their first attempt. Warm text latency was 1.448s after audio start, measured separately from Omi connection setup. The failed server soak still requires SSH access, diagnosis and a full 30-minute rerun.
