# Scheduler producer cancellation

The ordinary scheduler input controls use controlled settlement promises; they
do not prove that a real child has terminated. The producer cancellation control
in `tests/tools/scheduler-producer-terminal.test.mjs` connects the existing
fixture `runProcess` helper to `runDag.executeTier` with the same `AbortSignal`.
It waits for explicit readiness from one task-private child, requests abort, and
requires that child to be gone when the scheduler returns. Pending work must
remain unstarted even with `collectFailures` enabled.

The helper is consumed unchanged from its original owner's source
`0056263d2caf2cc0f16e3d8750fded698adef7e3`. It retains the original cancellation
error until the child closes and preserves the existing termination grace.
This partition does not introduce another helper or child termination owner.

This bounded component control covers one ordinary producer child. It is not
production process-tree, custody, cohort, native terminal qualification or the
complete nested grant conformance matrix. Earlier ordinary scheduler controls
and upstream control counts are not inherited as current child-exit evidence.
