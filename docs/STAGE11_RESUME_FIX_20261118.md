# Durable Stage11 checkpoint and late-stage resume (2026-11-18)

## Symptom
After an operator resumed an earlier Leningrad run, the web UI showed
Stages 1–9 restored but Stage10 running regional statistics again, with
Stage11 "waiting". This does not demonstrate that the earlier contacts
were lost: the old pipeline **always reentered Stage10** on resume,
regardless of a later saved `contacts`, `saby`, or `priority` phase.

There was also no guaranteed terminal Stage11 write. The batching
`flush()` only writes if pending updates exist, not when the last
contact checkpoint was already flushed. No explicit
`stage11_completed` marker was persisted after final QA.

Lastly, a partially resumed Stage11 checkpoint could be overwritten
with `final_inn`, `enrichment` or `statistics` as the paid Stage10
restarted. This effectively **downgraded the checkpoint phase**.

## Fix
1. After final contact QA, unconditionally persist a full
   `phase=contacts,stage11_completed=true` checkpoint:
   current final commercial result, QA report, all exact contact
   completed/unsearched ids, primary results, contact budget stats.
   `completed` here means **the scheduled bounded stage finished**,
   not that all contacts were found.
2. A compatible `contacts + stage11_completed` or strictly complete
   later `saby/priority/completed` snapshot resumes in **Stage12/13**
   without rerunning or paying for Stage10/11.
3. A fully classified Stage13 `priority` snapshot uses the existing
   fail-closed offline recovery and persists `completed` without
   Google AI, Saby or model calls.
4. A partial Stage13 resumes only model classification with saved
   source-fingerprint verdicts and current spending limits.
5. For old unfinished `contacts` snapshots without a terminal marker,
   the normal checkpoint continuation remains conservative. Any
   attempt to write a phase earlier than the original source is
   blocked, preserving the true latest durable checkpoint.
6. Stage12 carries forward Saby completed/attempted/deferred lists.
   If Stage12 is disabled for this server, existing lists are not
   reset or implicitly claimed finished.

No paid full study is needed to validate the fix; CI includes
offline tests for Stage11 complete, Stage13 complete, incomplete
contacts, and paused Saby checkpoints.

## VPS and browser
Do not restart the service while any full or Saby study is running.
Back up SQLite and pull `main` only when the queue is idle; then
restart. In the browser, select the region and the saved checkpoint.
A fast late resume will show Stage10+11 as restored (no repeated
identity, enrichment, statistics or contact OpenAI calls).
For Saby-only, continue to prefer the dedicated **без OpenAI**
browser button from the latest eligible checkpoint.

If the screenshot came from a **different** research job, its
actual source checkpoint ID and `phase` still need to be inspected
to distinguish a partial Stage11 from a fully saved one. Never infer
the exact SQLite phase from only a screenshot.
