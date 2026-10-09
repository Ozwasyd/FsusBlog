# Explicit bounded Server selection

This source proposal extends the original `backend-unit` entrance. It is not a
new runner or an aggregate coverage declaration. With no bounded selection, the
original Server path, locked Migration builder, whole independent Migration
assembly, admission/receipt readers, aggregate summary and integrity producer
remain unchanged. `backend-fast` still requires the original whole dependency.

The caller must set `FSUSBLOG_TEST_SELECTION=bounded-server` and
`FSUSBLOG_BACKEND_UNIT_SELECTION_FILE` to a regular repository-owned JSON file:

```json
{
    "schema": "fsusblog.backend-unit-server-selection.v1",
    "sourceState": {
        "commit": "<exact current scheduler source commit>",
        "worktreeFingerprint": "<exact current scheduler fingerprint>"
    },
    "methods": [
        {
            "fullyQualifiedName": "FsusBlog.Server.Tests.Unit.ExampleTests.Fact",
            "expectedCaseCount": 1
        }
    ],
    "migration": "not-selected"
}
```

This example is a schema illustration, not a permitted runtime case or receipt.
Each FQN selects a whole method and **all** its theory rows. The caller reviews
the exact source/data/hook scope and supplies each expected row count. Partial
row selection, substring filters, other assemblies, unknown fields, duplicate
methods and mismatched source identities refuse before discovery or execution.
Unknown selection modes refuse; unset, `full` and `affected` retain their original
paths.
The original ordinary category and LocalRedis exclusions are always conjunctive.

The original shell calls `run-migration-tests.mjs --backend-unit
--server-selection <file> --selection-action filter` to validate the declaration.
It then uses the existing `PrepareBackendPlatformPlan`, build/restore path and
VSTest discovery. `--selection-action verify` rereads that completed diagnostic
and platform plan, requires exact per-method counts, ordinary fixture-free
traits, unique actual IDs/display identities and the original Server assembly.
It writes a separate exclusive bounded plan. Only then can the original
`RunBackendDotnetFilterOnly` and `FinalizeBackendPlatformOutcome` run. The
`outcome` action binds the original TRX to those exact discovered case, method,
assembly and execution identities and all-passed counters. No ID or display
argument is guessed from a name/count. Selection/platform/source drift refuses.

`filter` takes only the two option/value pairs above. `verify` also requires
`--diagnostic-root`, `--source`, `--platform-plan` and `--selection-plan`.
`outcome` additionally requires `--trx` and `--out`. Unknown, duplicate, missing
or crossed-mode options refuse. These actions themselves never spawn an engine.

The bounded branch emits neither Migration execution/build/assembly receipts nor
the ordinary aggregate summary/integrity producer. A successful bounded control
run writes `.tmp/backend-unit/bounded-server-selection-outcome.json` with
`qualificationEligible=false`, `aggregateCoverage=incomplete` and then exits
**3**. That deliberate nonzero aggregate result prevents the unchanged matrix
from accepting partial coverage as a full backend-unit pass. Failed preparation,
discovery or original oracle retains its original nonzero refusal. Direct
Migration execution or aggregate dependency reads with a bounded marker refuse
before SDK/build/test access. Existing scheduler resource/service ownership,
namespace setup, Server build locks and cancellation remain with their original
owners; this selection does not authorize alternative service/runner setup.

Preparation explicitly propagates operation failures even when Bash conditional
dispatch disables implicit errexit. Membership planning, configuration, build,
runtime output/platform resolution, discovery preparation, VSTest discovery and
platform planning must succeed before bounded verification or execution.
Temporary discovery/output containment uses native path components on POSIX and
Windows, rejects parent escapes, sibling roots and cross-drive/share paths, and
retains canonical realpath checks against redirected directories. Portable path
controls exercise `path.posix` and `path.win32`; they are not Windows SDK or
filesystem runtime acceptance.

The audit includes the invoked Shell helpers, not only outer preparation calls:
runtime cleanup stops at the first failed removal; the filtered builder, original
oracle and post-test cleanup propagate refusal. Source/path resolutions and
run-once output splitting are checked before use. The default and conditional
controls preserve the actual helpers and stub only external operations; removal
stubs never delete runtime data. A readonly historical control retains the
original default cleanup exit 23 from `b566b33bb0a38f68f72515389ee04f0d942e8a0d`.

An explicit bounded request cannot fall back to whole-suite execution after a
failed or unresolved preflight. Empty/whitespace or unresolved filter values are
rejected before preparation and again before the original oracle. A missing or
failed platform filter also refuses. An actual CLI declaration with no selected
methods fails before any test command. The original whole paths remain available
when no bounded request was made; these refusal controls do not run those suites.

The source review controls cover declaration/option semantics, exact synthetic
discovery metadata and original shell routing only. They execute no real Server
or Migration case, fixture, SDK or acceptance receipt. The previously published
29-case consumer preflight remains a separate caller scope; none of its cases
is executed by these controls. Independent source review must precede consumer
execution. Held semantic/receipt/cohort/artifact/race audits remain unrun.
