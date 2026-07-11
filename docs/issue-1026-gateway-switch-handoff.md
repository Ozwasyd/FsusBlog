# Issue #1026 atomic gateway handoff

This document records implementation scope only. It is not a successful switch or rollback record.

## Landed behavior

- `production-openresty.conf` contains exactly one include directive for the controlled `active-upstream.conf` inside the stable upstream; it intentionally contains no built-in Blue or Green server line. Initialization and every later transition materialize the selected single loopback line through `gateway-control.mjs`.
- `gateway-control.mjs` accepts only the configured Blue/Green loopback lines, prepares and fsyncs a unique generated include plus staged full configuration, atomically installs the include and retains a durable source backup.
- `gateway-switch.sh` holds the shared host deployment lock, verifies source/target durable identity and target readiness, tests the staged full configuration, installs/reloads, verifies loopback and public release headers, then commits durable active-slot generation.
- Reload or post-install failure restores and re-tests the source include and records the failed stage. The old active state is not committed away on a failed transition.
- `gateway-rollback.sh` consumes only the recorded, running and identity-matching previous release. `gateway-recover.sh` diagnoses interrupted `switching` state from durable state, include and observed traffic without guessing.
- Dry-run reports source/target slot, release, digest, port and planned checks while leaving state/include untouched. Evidence excludes secret control headers.

## Direct test owners

- `tests/tools/gateway-switch.test.mjs` covers Blue→Green→Blue, unready targets, staged-config rejection, reload restoration, public identity verification, lock contention, interrupted recovery, invalid rollback identity, dry-run immutability and non-loopback include rejection.

## Risk and rollback

Before durable commit, source restore is automatic. After commit, rollback requires the retained previous runtime to pass exact identity and readiness checks. Database downgrade is never attempted by the gateway control plane.

## Validation status

No OpenResty, loopback, public traffic or test command was executed during code landing.
