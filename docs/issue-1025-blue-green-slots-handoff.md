# Issue #1025 Blue/Green slot handoff

This handoff is source-level only and is not proof that production containers have been started.

## Landed behavior

- `slot-lib.mjs` and `slot-common.sh` define only `blue` and `green`, with distinct loopback ports, Compose projects, container names, release identities and instance-local AOT cache/log/data volumes.
- Uploads, DataProtection material, PostgreSQL, Redis, the append-only release asset store and the release-derived volume remain explicitly shared. Derived writers are isolated by immutable `<releaseId>` subtrees and generation/pointer publication rather than separate slot volumes; candidate ports bind only `127.0.0.1`.
- `slot-start.sh`, `slot-stop.sh`, `slot-status.sh` and `slot-inspect.sh` validate immutable manifests and runtime labels, keep repeated operations idempotent, refuse active-slot stop and never stop the active slot after candidate failure.
- `slot-preflight.sh` checks Docker, memory, disk/image reserve, port use, shared volumes/network, active/candidate state and drain/stop-grace compatibility before candidate start. It also validates the immutable target image contract before Compose: pinned vcpkg label, Node present, npm absent and ReadyToRun disabled.
- `slot-state.mjs` persists active/previous slot, releases, digests, runtime generation, timestamps and transition results using mode-0600 temporary-file/fsync/atomic-rename writes.

## Direct test owners

- `tests/tools/deployment-slots.test.mjs` covers simultaneous distinct releases, independent health/identity, idempotency, active-slot preservation, restart recovery, occupied ports, bad digest/slot, insufficient resources, unsafe stop grace and loopback-only Compose wiring.

## Risk and rollback

A candidate failure records diagnostics without rebuilding or stopping the active project. State corruption or missing active identity fails closed; operators must reconcile against controlled container labels rather than guess a slot.

## Validation status

Docker and host-resource scenarios are implemented as test source but have not run in this landing phase.
