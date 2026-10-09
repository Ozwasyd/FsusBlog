# Original project probe and upstream historical URL evidence

Actual original-project candidate: `e618aa1315c91d729d96aa0c1613b7ddb031a5de`.
SDK 10.0.302 and supported `tools/build-with-data-env.sh` were used.

- Original fresh audited locked restore: exit1, NU1004 in the backend test project.
- Original Shared project build: exit0, zero errors and 187 visible warnings.
- Original test-project build, discovery and tests: not run; restore blocked them.
- No empty selection, full-suite fallback, gate change or lock regeneration.
- All49 input files remain unchanged. Only the backend test lock differs from
  the independently verified upstream49-input graph: one missing AngleSharp
  project-dependency row. The parent/sole lock owner must deliver its exact source.

[final-report.json](final-report.json) records the actual attempt and smallest
prerequisite request. Raw commands, exits and logs are retained here.

Upstream source `da5d862e575674595327b38388fb7417d256cfec` now has independent
SDK10.0.401 fresh audited locked restore, original-project build0errors with
1510warnings, and exact6/6ordinary value cases. Source, locks and49inputs stayed
unchanged. [upstream-canonical-url-verification.json](upstream-canonical-url-verification.json)
binds evidence commit `9751950ee844bae0f306b974782b9514b0f455a6` and verifies13hashes.
This supersedes the upstream six-case UNRUN only; it is not this candidate's test
execution, whole reader acceptance, source admission or runtime qualification.

Historical route/status/schedule remain absent; font338 is a separate source gate.
The earlier795source-host diagnostic cases stay bound to `f3928561` and distinct.
All16issues remain open. No held test, DB/content write, merge or deployment occurred.
