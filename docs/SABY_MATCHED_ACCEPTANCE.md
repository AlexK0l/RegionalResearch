# Paired acceptance: fleet completeness AND speed

Both metrics are release criteria. Existing offline regression tests cannot
establish live Saby yield or time. This diagnostic is bounded to 1–30 direct
buyers (default 12), the common fleet scope of old and new code. The read-only
saved-coverage audit separately includes all three commercial groups. It
does not equate unknown with zero and reports historical timing as null if
unavailable.

## Offline, safe even during an investigation

Run in the installed trusted checkout; use a private output directory.
For example (use the actual completed checkpoint UUID):

    node --max-old-space-size=256 scripts/saby-fleet-acceptance.js --audit --db=/opt/regionalresearch/data/checkpoints.sqlite --checkpoint=dd59f192-cf50-4148-90c3-2385a6eb0ebe
    node --max-old-space-size=256 scripts/saby-fleet-acceptance.js --plan --db=/opt/regionalresearch/data/checkpoints.sqlite --checkpoint=dd59f192-cf50-4148-90c3-2385a6eb0ebe --limit=12 --out=/private/acceptance-cohort.json

The cohort is deterministic round-robin by unresolved/positive/zero status
and exact INN, not hand-picked successes. Exclude duplicate INNs across
sheets, invalid checksums and known conflicting identities. Remove the
stored fleet and transport cell from diagnostic copies only, preserving
contacts, finance and saved verified identity/navigation hints. A positive
control must actually collect its fleet again. The original SQLite is read
only and nothing is posted to GitHub. Cohort files contain company rows:
keep them private and never commit them.

## Live comparison, ONLY after the production queue is empty

Do not stop a running study for this test. After it has finished, ensure no
standalone Saby/registry jobs are using the authorized profile, stop the
service normally, create a detached local worktree of the old revision
(6791f1e) and use the current tested revision as the candidate. The old
checkout must have its compatible dependencies available; do not change
package versions in a comparison. Use the same service user, environment,
DISPLAY, installed Chromium and authorized profile for both sequential
runs. The CLI refuses live Linux runs unless regionalresearch.service is
inactive and --idle-confirmed is present. It takes an exclusive benchmark
lock in the existing profile; never remove a lock while a browser is live.
It does not stop/start the service or download a browser.

From /opt/regionalresearch, using the actual paths with the service user:

    node --expose-gc --env-file=.env scripts/saby-fleet-acceptance.js --run --idle-confirmed --cohort=/private/acceptance-cohort.json --code-root=/trusted/old-checkout --out=/private/old-report.json
    node --expose-gc --env-file=.env scripts/saby-fleet-acceptance.js --run --idle-confirmed --cohort=/private/acceptance-cohort.json --code-root=/opt/regionalresearch --out=/private/new-report.json

Use normal service-user environment and protected local logs. The CLI
executes only trusted local code explicitly selected by the operator. No
paid OpenAI calls, no production SQLite writes, no changes to saved
research, no concurrent browser sessions. Both runs use the same contact-
first strategy, fixed delay, strict full fleet path, same profile and
direct-only scope, no registry/GIRBO work. The report measures browser
plus scheduler elapsed time, not production SQLite I/O or total research
duration. If either browser run is incomplete, do not declare a speed gain.
Restore the normal service after the two sequential diagnostic runs.

    node scripts/saby-fleet-acceptance.js --compare --baseline=/private/old-report.json --candidate=/private/new-report.json

Requires exact same cohort bytes, settings digest (including Node version,
package-lock hash), region and identity keys; checks each company's full
model/year multiset (including identical vehicles), count and contact/finance
facts. Compare positive/zero controls with their previously verified saved
inventories as well, so two failed rereads of a known fleet cannot pass.
Report gained positive and confirmed-zero fleets separately. A changed inventory is flagged
for review, not automatically attributed to the algorithm, because the
live source may change between runs. Reports counts of gains/losses,
elapsed time, attempts, full searches, fleet/search timings, and complete
positive fleets/hour. Compare only a completed matched pair; a faster
incomplete sweep or a reduction in verified coverage never passes. A
faster equal-coverage sample does not prove the goal of increased coverage.
This is a targeted diagnostic, not a statistically representative sample
or proof that Saby exposes every vehicle. No speculative other-category
selectors are introduced. Review actual source DOM before expanding beyond
the verified truck category. For fairer timing, repeat in reverse order if
the profile/cache state or network was materially different; no automatic
mass replay of completed regions.
