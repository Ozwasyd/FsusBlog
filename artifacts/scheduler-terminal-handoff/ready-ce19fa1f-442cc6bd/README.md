# Ready ordinary scheduler increments

Two separate source candidates are published. Their ordinary controls are not
combined into one source qualification. No GitHub content API writes, PR
creation, issue comments, merge, deployment or package publication occurred.
The coordinator owns review, PR publication, integration and justified closure.

| Candidate | Exact source | Parent/base | Branch | Changed files |
| --- | --- | --- | --- | --- |
| Actual producer terminal | `ce19fa1fffbbf58e9c1b14c512fa4b22400a97c9` | `daa14c2f54be6961791aa2eb77166e762355915f` | `task/scheduler-producer-terminal-boundary` | 3 |
| Actual release consumer readback | `442cc6bd979c88b6af4a3fbe63583af61f4768bd` | `aeaf10e6f9fa215312c97d07c76c00ca55ed9e23` | `task/release-consumer-scheduler-readback` | 4 |

The first candidate consumes the original owner's exact helper fix
`0056263d2caf2cc0f16e3d8750fded698adef7e3`. Its helper preimage matches;
the consumed Git blob is `7a2ccbaa19e4b7d86dae914e7b3f6f3c53b7fe5d`.
One ordinary control connects actual `runProcess` to `runDag.executeTier`, waits
for task-child readiness, aborts and asserts the child is gone when the scheduler
returns. Pending work remains unstarted. This is a bounded real child control,
not complete nested admission or native process-tree qualification. Upstream
9/52 results and prior 14 controlled-settlement results were not rerun or inherited.

The second candidate ports the exact version 1 verifier from
`7263179c059f8b119577ff83954c637bdc1a128f` onto the actual consumer base.
It adds a strictly read-only canonical reader and an owned controlled fixture.
The existing private compatibility reader and all following writers are byte
identical to the consumer base; release owner files are unchanged. Explicit
current identity and independently expected after-commit revision are required.
The returned digest is the actual retained wrapper reference's `inputDigest`.
No write, repair, reseal, retry, fabricated final output or qualification occurs.

Before tests, indexed closure inspection found no errors. The producer file has
one callback and selects one. The API file has three callbacks and selects three.
The actual consumer file has 24 callbacks and selects only its ordinary positive
API-composition callback; the remaining 23 are not executed. Its actual v2 output
producer and canonical scheduler store are used without mocking the scheduler
API. Results are 1/1 producer, 3/3 API and 1/1 consumer, with zero skips.

Node is v24.16.0. ESLint, one-file Markdown (`--no-globs`) and bounded commit
ranges exit 0. Exact argv, source identities, outputs and exits are in `checks/`.
The initial producer fixture failure and accidental broad Markdown scans are
retained with their failed exits; the unrelated docs were not edited. The fixture
DAG correction did not change scheduler or helper behavior. Earlier incorrect
ESLint target preflights are recorded as errors, never as passes.

`source-scope.json` lists every changed path. `source-export-manifest.json`
binds all seven exported files to their exact source Git blobs and SHA-256 bytes.
`capability-contracts.json` records API semantics, original ownership and frozen
refs. `verification-summary.json` separates pass/fail/unrun.
`issue-by-issue-gaps.json` preserves the remaining assigned acceptance gaps.

Held cohort, native terminal, race, TOCTOU, artifact substitution and equivalent
wide suites remain UNRUN. Original #3521 must regenerate reserved execution
fixture/index with the official Node24.16 producer on the final integrated
candidate; no old SOURCE/P2 evidence transfers. Original generic manifest live
generation uptake and sibling-release dual-resource nested timeline remain OPEN.
The frozen `6ed505c7`, `83d4908a` and `0d2a45f8` refs were verified unchanged.
