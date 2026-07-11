# Issue #1031 Notification Evidence Handoff

## Outcome

`tools/deployment/release-notification-probe.mjs` no longer treats replay miss as
“clear a local Set and reconnect.” A `4009/fsus_replay_miss` now requires a real
same-origin full-state request from both a guest browser context and the supplied
authenticated storage-state context. The probe fails closed unless each response:

- comes from the target release/slot;
- returns the configured monotonic notification watermark;
- returns a declared SHA-256 that matches the actual response bytes;
- has the configured content type and bounded non-empty body;
- is fetched again after drain and post-resync events, with a non-regressing
  watermark and the same state-content hash.

Only after the first snapshot passes does the client clear its bounded stream
dedupe window and reconnect from the snapshot watermark. This prevents a local
cursor reset from being reported as full-state recovery.

## Configuration

Set `FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO` or pass
`--resync-scenario <file>`. The schema is
`fsusblog.release-notification-resync-scenario.v1`; a complete shape is in:

`tests/fixtures/deployment/release-notification-resync-scenario.template.json`

The template paths describe the required state API contract. Deployment must bind
them to real guest/auth full-state endpoints. Each endpoint must return:

- `X-Fsus-Release-Id` and `X-Fsus-Release-Slot` for the serving target;
- the configured watermark header as a positive safe integer;
- the configured content-hash header as lowercase 64-hex SHA-256, optionally with
  the `sha256:` prefix;
- raw bytes whose SHA-256 equals that declared hash.

The scenario contains no Cookie or Authorization value. The guest snapshot request
obtains a fresh PoW through the same guest proof builder and sends it only as
`X-Fsus-Pow-Proof`; authenticated cookies remain inside the auth browser context.
Admin authorization remains confined to the existing mode-0400/0600 admin-header
file used only by loopback drill publish.

## Evidence semantics

The existing evidence schema name remains
`fsusblog.release-notification-stream-evidence.v1` for rollout compatibility and now
sets `contractVersion=2`. The report binds:

- rollout/source/target identity and hashes of rollout, auth-state and scenario
  inputs;
- exact `1012/fsus_service_restart` and `4009/fsus_replay_miss` closes;
- observed reconnect delay and preserved 1012 cursor;
- stream event ID plus drill `drillId:sequence` business event ID;
- no loss and exactly-once application on guest/auth and post-resync clients;
- replay-miss and final snapshot watermark/body hash for guest and auth;
- source-drain file hash, zero blockers/errors and the slow-client deadline.

Final evidence uses exclusive creation and refuses to overwrite an existing output.
Snapshot response bodies, cookies and admin credentials are not copied into the
artifact. Errors are deduplicated but never capped or tail-truncated.

## Direct coverage

- producer: `tools/deployment/release-notification-probe.mjs`
- direct test: `tests/tools/release-notification-probe.test.mjs`
- scenario fixture: `tests/fixtures/deployment/release-notification-resync-scenario.template.json`
- handoff: `docs/issue-1031-notification-evidence-handoff.md`

The producer, direct test and resync fixture are already registered under the
`zero-downtime-release-rehearsal` coverage owner, relevant matrix/requirements
tiers and static governance; no central registration remains pending.

No validation was run while landing this issue code.
