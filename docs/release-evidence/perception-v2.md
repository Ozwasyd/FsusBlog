# Perception V2 Release Evidence

This page records the release-evidence contract for perception-sealed@v2 runtime validation.

## Gate

Run:

```bash
./tools/test.sh perception-v2-test-matrix --no-deps
```

The lane validates the static security matrix, runs the backend E2E fixture, then checks the generated runtime evidence:

- `.tmp/security/perception-v2-e2e-runtime.json`
- `.tmp/security/perception-v2-test-matrix.json`
- `.tmp/release-evidence/perception-v2-release-evidence.json`

## Verified Runtime Surface

Current E2E runtime coverage is intentionally narrow and production-like:

- Task kind: `text-task`
- Challenge kind: `perceptionTextTaskV2`
- Business flow: `comment.create`
- Flow path: `issue -> render -> verify -> proof -> business-action-resume`

The fixture issues a real sealed perception assignment through the backend provider/orchestrator, parses the render recipe, verifies the submitted answer, mints a challenge proof, and resumes a simulated `comment.create` write only after proof consume succeeds.

## Failure Cases

The gate covers these fail-closed paths:

- `wrong-answer`
- `expired`
- `duplicate-submit`
- `action-mismatch`
- `route-mismatch`

## Performance Evidence

The runtime evidence records:

- `issueP99Ms`
- `verifyGateP99Ms`
- `clientRenderP95Ms`
- `asyncAuditQueueObservedCount`

The red-team benchmark remains the budget gate for the broader synthetic family/variant surface. The runtime E2E gate proves that the comment-create path emits concrete performance evidence and queues audit events without requiring synchronous PostgreSQL persistence in the request path.

## Known Gaps

- `localization` and `microInteraction` remain covered by provider/frontend matrix lanes, not by this first backend business-flow E2E.
- This issue does not add new generator families.
- This issue does not add FsusUI components.
