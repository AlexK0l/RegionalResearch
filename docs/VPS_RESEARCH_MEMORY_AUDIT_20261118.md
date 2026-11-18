# Memory audit and real-time measurement on Time4VPS (2026-11-18)

## What 1.5 GiB per study may mean
The project runs the Node.js Express backend, OpenAI research data in a
long-running job, Python for XLSX export, and Chromium/Playwright for
Google fallback and Saby. Systemd's `MemoryCurrent` covers all descendant
processes and (depending on cgroup) filesystem cache. This is **not**
the same as Node's `heapUsed`.

Code audit found extra peak allocations:
- The in-memory HTTP `jobs` map kept `latestCheckpoint`,
  `job.data.checkpoint`, and `job.result.result`, each potentially
  including the same full region database until a 24-hour eviction.
- `saveCheckpoint` made an extra stringify/parse deep clone of a
  potentially large snapshot, even after `job.updateCheckpoint` had
  validated and cloned it; the SQLite write then serialized it again.
- A long study uses multiple datasets concurrently:
  discovery parts, identity/dedupe/enrichment, contacts, review and the
  Stage13 scoring workbook. Chromium processes have their own RSS.

These mechanisms **contribute** to memory use, but none proves that
1.5 GiB is an individual Node leak without a real measurement.

## Changes
1. SQLite checkpoint upsert validates and serializes once, using only
   a shallow top-level copy to add `pipeline_version`. It never
   modifies the caller's checkpoint or its nested business records.
2. HTTP jobs retain a compact checkpoint **summary** rather than the
   entire latest checkpoint after each SQLite write.
   `/api/jobs/:id/checkpoint` and Resume load from SQLite.
3. After successfully committing a completed or paused Saby/full
   result, the HTTP jobs map drops its duplicate `result` table.
   Existing XLSX/JSON/QA download APIs read the durable result
   from SQLite; no new OpenAI or Saby calls are made.
   Diagnostically incomplete runs without a saved final result keep
   their original in-memory payload and error controls.
4. The normal browser job screen shows:
   **Node RSS**, **Node JS heap**, and **entire service cgroup
   including Chromium/cache**. Values are MiB. A REST endpoint
   `/api/runtime/memory` is protected by the existing API authentication.
5. For every real job, logger writes bounded `[JOB_MEMORY]` samples
   at start, finish, stage transitions and every 60 seconds. The
   monitor stops when the job ends. No environment variables, heap
   dumps, customer data, cookies, or selectors are logged.

## How to diagnose the next actual study without synthetic tests
Watch the memory values on the ordinary HTTPS jobs screen or
inspect `[JOB_MEMORY]` in existing job logs. Interpretation:
- `cgroup_total_mib` ~1500, `node_rss_mib` ~200–400:
  most attributed to Chromium children, Python, shared pages or
  cgroup page cache. Do not set `--max-old-space-size` as a fix.
- `node_rss_mib` ~1300 and `node_heap_used_mib` ~1000:
  optimize live Node object lifetimes, checkpoint serialization,
  and concurrency; investigate whether heap keeps rising between
  stages after garbage collection.
- Both low after a completed job but elevated only during Saby:
  Chromium memory peak is expected; verify browsers close and are
  not orphaned before declaring a leak.

An independent **read-only** systemd check on VPS:
```bash
systemctl show regionalresearch \
  -p MainPID -p MemoryCurrent -p MemoryPeak
ps -eo pid,ppid,rss,comm --sort=-rss | head -n 20
```
RSS in `ps` is KiB; do not sum process RSS without accounting for
shared memory and systemd cgroup file cache.

## Deployment policy
Do not kill or restart an active paid study. After the queue is idle,
back up the SQLite WAL-consistent database, pull `main`, and restart
once. No new full paid study or single-company Saby smoke is required.

`MAX_ACTIVE_FULL_JOBS=10` is an upper concurrency cap, not a memory
budget. At a 1.5 GiB **per-study** peak, 10 concurrent studies would
require potentially well over 15 GiB before operating-system reserve.
Use a value matched to real VPS RAM and headroom (typically one or
two on a small VPS), and do not assume that sharing the Saby
persistent profile removes all independent Node/Chromium costs.
