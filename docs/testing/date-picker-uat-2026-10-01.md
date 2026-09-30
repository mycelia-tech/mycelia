# Shared date picker UAT — 2026-10-01

Implementation checks pass; full end-to-end UAT acceptance remains incomplete
after intermittent backend/frontend unavailability during the session. No audio processing,
exports, rebuilds, or data edits were submitted during browser testing.

## Verified scenarios

| Scenario | Evidence |
| --- | --- |
| Previous/next month, month/year selection, keyboard navigation and Escape | Live Search picker; calendar regression tests |
| Year list opens at the selected year, scrolls without closing, stays above selected days | Live Audio Export picker; initial-mount regression test |
| Start/End activation, independent edits and calendar highlight | Live Search and Audio Export; controlled-selection regression tests |
| Widely separated boundaries jump to the selected month | Regression test with January–August range |
| Narrow viewport and internal scroll | Live 320×640 viewport: dialog x=16..304, body width=scrollWidth=286, scrollTop reached 283; footer remained visible |
| Same-day date-only range, configured timezone | Live AI History applied a one-day range; zoned-midnight regression tests |
| Seconds, reversed ranges, exact min/max and processing duration limits | Live seconds fields; component regression tests |
| Open end and nested Cancel/Apply/Save isolation | Actual TimeRangeEditDialog integration test |
| Timeline edge adjustment without audio density | Live ArrowRight changed start by 1000ms and left end unchanged |
| Snapping with audio intervals, gaps and domain boundaries | 15 helper tests; real density later loaded for August 9–18 |
| Repeated keyboard steps with loaded density | Regression reproduced live: snapping erased small steps. The fix uses exact keyboard steps while preserving pointer snapping; real Slider regression test verifies repeated movement and unchanged opposite edge |
| Legacy end-only photo filter | MediaAnalysisPage integration test: edit only `to`, keep `from` absent, Cancel and Clear |
| Single-instant Apply while paused/playing | AudioPlayerPage tests with real player store and picker; no physical playback engine mounted |

Source audit covered all 13 DateRangePicker call sites: Search, photo analysis,
AI History, Jobs UTC maintenance, Transcript, Audio Export, voice review,
location assignment, diarization launch, speaker-identity launch, object time
editing, voice operations, and Run Job. The two single-instant callers are
AudioPlayerPage and the audio-module toolbar. This is not a claim that every
data-dependent dialog was opened successfully in the browser.

## Automated verification

- Final combined targeted run: 8 files, 63 tests passed; 12 edited TypeScript files
  passed lint and formatting checks; all 6 edited production modules type-checked.
- The final keyboard fix also passed its 25-test focused regression group and
  fresh formatting, lint and DateRangePicker type checking.
- Earlier full frontend run: 511/512 tests passed. The one baseline failure is
  `audioPipelineStats.test.ts`: its expected fallback omits `blocked: 0` already
  present since commit `f56a523f`. This run predates the last caller regressions.
- Normal sandbox test invocation also hit Deno localStorage's readonly cache.
  The isolated invocation below removed those environment failures.
- Production build passed after 8133 transformed modules (19m7s under host
  contention), before the final caller and presentation edits. Those final
  edits are covered by targeted tests/type checking, not a second full build.

Run from `frontend`, with an isolated writable Deno cache when needed:

```sh
picker_cache=$(mktemp -d /private/tmp/mycelia-picker-tests.XXXXXX)
DENO_DIR="$picker_cache" deno run -A --cached-only --node-modules-dir=manual --no-lock \
  node_modules/vitest/vitest.mjs run \
  src/components/DateRangePicker.test.tsx \
  src/components/ui/calendar.test.tsx \
  src/components/ui/datetime-picker.test.tsx \
  src/components/ui/slider.test.tsx \
  src/lib/datePicker.test.ts src/lib/audioRangeSelection.test.ts \
  src/pages/AudioPlayerPage.test.tsx src/pages/MediaAnalysisPage.test.tsx \
  --maxWorkers=1 --testTimeout=15000
```

## Runtime boundary

The original picker commits `bddae191` and `1cf0f8ec` were already ancestors of
both local and remote `sky-uat`. Frontend/backend mounts were confirmed against
this checkout and development mode. A frontend/nginx restart cleared a cached
PostCSS failure, after which CSS, main module and picker module returned 200;
frontend emitted a fresh `[READY]` and readiness initially returned 200.

Later Mongo queries timed out under Docker VM contention (9 CPUs, load 44.53,
CPU pressure 78.2%). The backend dependency watchdog exited its child at
2026-09-30T21:00:59Z; its development watcher waited for a file change while the
container remained running. `/readiness` returned 502. The frontend subsequently
rendered the corrected picker, but histogram API requests still returned 502.
Loading a form is not proof that data-backed workflows are ready.

At a later check readiness returned 200 again and backend/frontend/MongoDB/Redis
were all healthy. Real density subsequently loaded for the historical August
9–18 range. The frontend became temporarily blank again during subsequent
source reloads, so a stable full-session acceptance result is not claimed.

Before full acceptance: verify stable readiness and actual data requests, then
repeat final pointer/keyboard behavior with loaded density, data-dependent
launch/object dialogs, and real playback seeking. Database or unrelated workload
restarts were not performed by this task.
