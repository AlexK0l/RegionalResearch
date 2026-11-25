# Automatic memory admission and durable cooperative suspension

Enabled by default; disable only with RESEARCH_MEMORY_GUARD_ENABLED=false.
The existing MAX_ACTIVE_FULL_JOBS is still an upper bound, never a RAM
guarantee. Linux MemAvailable (not MemFree or swap), finite cgroup v2
memory.max / memory.high at every visible ancestor, and V8 heap headroom
all constrain admission. Conservative defaults: 1536 MiB per study,
384 MiB (or 12% of effective RAM) reserve, 256 MiB estimated JS heap per
study, 256 MiB (or 8%) heap reserve. Additional active-job growth margin,
one start per five seconds, two-second polling and 15 seconds of stable
headroom after pressure. Settings are in .env.example. On a small VPS the
defaults may intentionally admit zero jobs: tune against measured peaks,
not against available swap or a desired arbitrary concurrency count.

When headroom is insufficient new jobs remain in the queue. A high-pressure
sample requests cooperative suspension of the newest active resumable job;
critical pressure requests suspension of all active resumable jobs. No
SIGKILL/SIGSTOP, process restart, browser/profile kill or cancellation of
in-flight paid requests is used as a memory-control strategy. Diagnostics
share admission, but do not pretend to be resumable production jobs.

Safe suspension occurs only after a successful SQLite checkpoint, with
known concurrent work drained. Discovery commits completed primary branches
when requested, and completed stage/identity/dedupe/qualification/statistics
boundaries are safe. Final INN, ordinary enrichment and primary contact
workers stop taking new batches, drain already started batches, and force
their existing durable ledgers. Enrichment also drains and stores its
concurrent statistics request, so resume does not repeat that request.
Secondary contact/identity/conflict processing without a complete partial
ledger finishes its existing safe phase before yielding. Sequential Saby,
GIR BO and full Stage13 use their checkpoint boundaries; Saby-only pauses
only while there is a resumable pending queue. Completed/reviewed records
are subject to the existing resume policies, not a new paid discovery.
An interrupted/uncommitted request is not claimed as completed.

The job unwinds, closes browser resources, drops the full in-memory source
payload and releases its active slot. The region reservation and same job
ID remain. Memory-paused jobs have a compact SQLite marker, not another
copy of the research database. They are prioritized when admission recovers.
A marker survives a normal service restart, and is removed before actual
execution or user cancellation. An abrupt OOM/host crash during an active
attempt is NOT blindly replayed: use the last durable checkpoint manually.
Existing paid budget accounting is restored from the checkpoint. Pending
normal jobs are still process-local. Source snapshots that already exist in
SQLite are loaded only after admission.

UI: memory_wait / memory_paused, pause requested, available memory and
reserve in job list; ETA suspended while waiting. Manual cancellation of
a paused job prevents automatic revival. Monitor MEMORY_ADMISSION,
MEMORY_PAUSE_REQUEST, MEMORY_JOB_PAUSED/RESUMED/RESTORED in service logs.
No new paid run is required for regression tests.

Limitations: this is preventive, cooperative load control, NOT an absolute
OOM guarantee. V8 may retain committed pages, sudden allocations or an
external process can exhaust RAM before the next sample or safe boundary;
some long phases cannot safely yield mid-request. No destructive OS memory
limits are imposed. If memory remains insufficient, a saved job stays paused
rather than looping or pretending to be completed. Actual RAM recovery and
timing depend on VPS size, process memory, Chromium and workload. An operator
can manually cancel a paused job or resume from its checkpoint. Do not
reduce reserve below observed needs just to force concurrency.
