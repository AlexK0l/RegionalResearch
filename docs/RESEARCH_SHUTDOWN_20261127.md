# Durable job lifecycle and service shutdown

Production evidence (27 November): systemd reached its 90s stop deadline
while Stage12 rotated Chromium. Two further active jobs were interrupted
during the following service stop; their checkpoints survived, but their
queue intents had already been consumed. Do not treat active crash markers
as permission to replay paid calls.

The new compact SQLite lifecycle journal is written before consuming a
queue intent and refreshed after a successful checkpoint. Existing queued
and cooperative-pause records remain the only automatic admission sources.
The startup job history restores journaled interrupted/terminal records
without reading whole result payloads; interrupted jobs require explicit
resume. A checkpoint may precede an uncommitted paid response, so manual
resume can repeat that response. No arbitrary historical checkpoint is
automatically scheduled. Older jobs not journaled by this version remain
available from the region checkpoint history. Existing queues are unchanged.

SIGTERM/SIGINT stop admission, reject a waiting browser reservation and ask
active research to unwind at the existing safe checkpoints. Playwright
launches made by the web server leave these two signals to the application.
Standalone scripts retain their default signal handling. The provided systemd
unit uses KillMode=mixed and TimeoutStopSec=180 so the main process receives
SIGTERM first and remaining children are forcibly terminated on timeout.
A safe point may take longer than this; the durable interrupted marker is
the fallback, not a promise that every request will be saved. Do not
automatically repeat an interrupted request. Do not install or restart a
live service during active work just to test this change.

The systemd template change does not modify an already installed service.
Review its effective drop-ins and stop settings, then install the changed
unit only in a planned idle deployment; daemon-reload by itself does not
restart it. Verify an idle stop/start and a deliberately isolated fixture
with queued and interrupted jobs before any production stop test.

No changes to research budgets, eligibility, browser concurrency, Saby
selectors, output schema or existing checkpoint payload versions.
