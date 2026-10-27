# Mycelia recovery verification, 2026-10-27

This records completed runtime operations and persisted results after recovery.
No 60-minute stream or server reboot was performed. Private receipts retain the
job/source identifiers; transcript text, credentials and recording titles are
excluded from this report.

## Model disk and service recovery

The [limited sudo and dinit mount guard](ops/faeon-boot/README.md) is installed.
The installed helper and service SHA256 hashes match the reviewed bundle.
`sudo -n` status verified ext4 UUID
`816b292e-4e7e-4965-85b8-24abbb3e000d` mounted read/write at `/mnt/datadrive`;
the repeat mount command returned `changed: false`. The dinit dependency graph
passed validation. These checks establish the current mount and installed
configuration; next-boot behavior has not been tested.

The current file diarizer is `sky-diarization-candidate-diarization-1-1`, image
release `6f014f56-eb4dabb0`, on Tailscale port `8085`. The legacy
`sky-diarization-1` remains stopped. Startup DNS failure was traced to an empty
Docker network attachment list and empty `/proc/net/route`. Reconnecting the
existing `sky-diarization-candidate_default` network with alias `diarization-1`
restored DNS and readiness. Its exact embedding space is
`6a1ce44db3601802f6d1d8ee0b2d7e97de1602906ce63c219816087eb7feb09f`, matching
[the current compatible runtime](../diarizator/PORTAINER.md).

The five unavailable routes on ports `8086`–`8090` were disabled. Port `8085`
remains enabled with concurrency one, and the diarization worker was resumed.

## Persisted processing results

| Stage | Observed result |
|---|---|
| Voice Memos import | 28 recordings imported; latest import `2026-10-27T10:17:45Z` (14:17:45 in Tbilisi). |
| File transcription | A real Mycelia job completed five sequences, about 917 seconds of audio, using `large-v3-turbo`. |
| Summarization | A fresh 969-character summary was saved at `14:49:27Z`, with five source transcriptions and primary Qwen 27B provenance. Three more summaries were saved at `14:50:19Z`–`14:50:44Z`. |
| File diarization | A bounded job completed one 9.9935-second chunk, persisted three segments with `SPEAKER_00` and 256-dimensional embeddings, reported zero errors and `hasMore: false`. |

The diarization job recorded 676 ms in the provider stage, 31.5 seconds between
job processing and completion, and a separate 98.7-second admission wait. These
are different timings, not a claim that the complete operation took 676 ms.
The single-speaker sample proves inference and persistence, not multi-speaker
quality or long-session reliability.

Normal backlog processing subsequently recorded three first-attempt
`provider_network` / `RemoteDisconnected` failures. All three chunks completed
on automatic retry and their source failures cleared; historical errors were
retained without a queue reset. The first failing job finished at `14:58:08Z`;
its affected chunk completed at `14:59:47.340Z` with a valid zero-segment result.

The failures occurred 4.928, 5.045 and 5.023 seconds after the preceding completed
server request. The actual Uvicorn keepalive timeout was five seconds, the client
reused TCP connections, and there was no proxy in that path. The unchanged
diarizer container reported zero restarts and `OOMKilled: false`; inspected logs
contained no OOM or CUDA errors. Together these observations support a race
with keepalive connection closure; they are not packet-level proof.

The deployed [diarization client fix](../python/lib/diarization_runtime.py) adds
`Connection: close`, avoiding reuse at the cost of a fresh TCP connection per
request. HTTP `max_retries=0` and source-level retry backoff remain unchanged.
Twelve tests passed locally and inside the actual Python worker image, including
two credential-free loopback cases proving fresh connections and no automatic
replay of a disconnected POST.

The seven affected Python queues drained to zero active jobs. VAD finished
100/100 normally at `15:09:48Z`, without cancellation. Only `python-worker` was
recreated at `15:11:46.660Z`, with the primary checkout mounted; startup completed
at `15:13:11.986Z`, health returned 200, and the effective connection header and
retry setting were verified. Nginx was restarted per the runbook; backend,
MongoDB and Redis were not restarted during this reload. All seven previously
enabled queues were resumed.

The first normal post-change job completed at `15:16:57.703Z`: eight sequences,
44 chunks, 439.98 seconds of audio and 138 persisted segments, with zero errors.
The artifacts record `inference_response` provenance and the expected embedding
fingerprint. A second normal job was active at this observation; the historical
error count remains three. Nine observed post-change provider requests used nine
distinct TCP source ports and all returned HTTP 200. This confirms bounded
production processing after the change, not completion of the full backlog or
a sustained reliability run.

The latest imports and their import/recording times are visible in
**Audio Pipeline → Audio import → Last five imported files**. **Last import**
uses the persisted import timestamp; **Last scan** describes source discovery.
The card refreshes every 15 seconds while visible. Processing state is shown in
**Jobs → Pipeline health & recovery**; importing audio and finishing all later
jobs are separate events.
Some dashboard aggregate queries timed out under load and returned partial
counts; the job completions and persisted artifacts above were checked
independently.

## Resource and tooling limits

GPU sampling every two seconds for 90 seconds observed at most 21,842 MiB used
and at least 2,320 MiB free while three GPU processes were present. WLK was not
part of this measurement. A later separate snapshot showed 21,844 MiB used and
2,318 MiB free; it is not part of the 90-second sample. The Docker RAM snapshot
was Qwen 9.252 GiB, Whisper 2.248 GiB and diarizer 1.557 GiB, totaling 13.057 GiB
of container working usage, not total host RAM or peak demand.
This short sample is not a capacity guarantee, a
measurement of every service's combined peak, or a sustained-load test.

The September30 root-owned `/usr/local/bin/qwen-switch` is a historical copy.
A later inspection found the maintained user-owned command in `~/.local/bin`;
its canonical file-container selection and controls were updated in the
[separate qwen-switch verification](ops/qwen-switch/VERIFICATION-2026-10-27.md).
This recovery's resource sample above still excludes WLK.
The [earlier Omi rotation verification](VERIFICATION-2026-10-23-ROTATION.md)
retains its own live-session failures and limits; these file-pipeline results
do not replace that evidence.
