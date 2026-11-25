# Saby on a 2 GiB VPS: planned browser recycling and durable idle recovery

The November 26 production trace recorded 1,262 MiB available before Chromium,
363 MiB at the pause, and 886 MiB after all Chromium processes had closed.
Node RSS remained about 642 MiB. This is evidence of retained RSS, **not proof
of a JavaScript leak**. Do not lower the guard thresholds to conceal it.

Production Saby still has no overall time limit. Every 25 committed section
tasks, close the persistent context, reclaim garbage, and obtain fresh measured
browser headroom under the SAME priority reservation before reopening. The
durable per-section cursor prevents replay. Rotation is not a failure/retry.
Reclaim dead JS objects every 10 tasks; the queue also shrinks disposable
SQLite page caches during idle/pressure GC. Production serial Stage12 writes
avoid redundant JSON copies; every company is still synchronously committed
with the same SQLite durability and checkpoint format.

Settings (existing systemd environment files continue to apply):

- SABY_BROWSER_RECYCLE_EVERY=25 (1..200)
- SABY_GC_EVERY=10 (1..100), requires Node --expose-gc
- RESEARCH_MEMORY_SABY_RESUME_MARGIN_MIB=192 (additional snapshot hydration headroom)
- RESEARCH_MEMORY_IDLE_RECYCLE_ENABLED=false by default. Opt in ONLY on a
  Linux systemd service configured to restart after exit code 75.
- RESEARCH_MEMORY_IDLE_RECYCLE_STALL_MS=120000
- RESEARCH_MEMORY_IDLE_RECYCLE_COOLDOWN_MS=1800000
- RESEARCH_MEMORY_IDLE_RECYCLE_MIN_RSS_MIB=384

Idle recycling requires a continuous measured admission stall, zero executing
jobs, zero in-flight HTTP requests, no startup browser, no non-durable results,
and verified SQLite queue/pause markers for EVERY pending job. Diagnostic
queues are not eligible. A persistent SQLite cooldown prevents fast restart
loops. A new server process restores the same durable paused/unstarted jobs.
The process does NOT exit when an active paid call or browser task is running.

Under systemd, use a separate environment drop-in enabling the recycler and
confirm Restart=on-failure (exit 75 must not be excluded). Keep --expose-gc.
Back up SQLite before updating and avoid interrupting executing studies.
Use a small swap file only if the host supports it and disk space is adequate.
Swap is emergency protection, not extra admitted RAM: the guard measures
MemAvailable and V8/cgroup headroom, not swap capacity.

Logs: SABY_BROWSER_ROTATED, SABY_MEMORY_GATE (reopen_requested/granted),
MEMORY_PAUSE_REQUEST, MEMORY_JOB_PAUSED/RESTORED/RESUMED,
MEMORY_IDLE_RECYCLE (requested/refused), MEMORY_ADMISSION and JOB_MEMORY.
An exhausted or genuinely undersized host can still need intervention; the
idle recycler is bounded recovery, not a claim of an OOM-proof service.
