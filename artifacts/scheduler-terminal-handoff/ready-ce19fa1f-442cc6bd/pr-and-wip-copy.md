# Coordinator publication copy

These texts are prepared for the coordinator; they have not been posted.

## Producer terminal PR

Title: `test(test): verify producer child terminal before scheduler settlement`

The existing scheduler cancellation controls used controlled settlement promises.
This candidate connects a real task-owned child through the original #1679
helper fix to `runDag.executeTier`; scheduler cancellation must wait for child
close and leave pending work unstarted.

Source: `ce19fa1fffbbf58e9c1b14c512fa4b22400a97c9`, branch
`task/scheduler-producer-terminal-boundary`, base
`daa14c2f54be6961791aa2eb77166e762355915f`. Exactly three changed files:

- `tools/test-fixtures/producers/spawn-helper.mjs` (unchanged owner blob consumption).
- `tests/tools/scheduler-producer-terminal.test.mjs`.
- `tools/test-matrix/scheduler-producer-terminal.md`.

Node24.16 `--test tests/tools/scheduler-producer-terminal.test.mjs` exits 0:
1 pass, 0 fail, 0 skip. Indexed closure inspection, changed ESLint, one-file
Markdown and bounded commit-range checks exit 0. The first failed fixture
candidate and original exits remain in the handoff evidence. Native, cohort,
complete nested admission and full Production cleanup acceptance remain UNRUN.
GitHub CI is disabled; no dispatch or wait occurred.

Refs: #1934, #1965, #1679

## Release consumer compatibility PR

Title: `feat(test): adapt readonly scheduler evidence API to release consumer`

The exact release-final consumer has a v2 output producer and calls the committed
scheduler readback API, but its source base lacks that API. This candidate ports
the exact version1 verifier and a strictly read-only canonical reader onto
`aeaf10e6f9fa215312c97d07c76c00ca55ed9e23`, preserving genuine current identity,
independently expected committed revision and actual wrapper digest. Release
owner files and existing scheduler writers remain unchanged.

Source: `442cc6bd979c88b6af4a3fbe63583af61f4768bd`, branch
`task/release-consumer-scheduler-readback`. Exactly four changed files:

- `tools/test-matrix/scheduler.mjs`.
- `tests/tools/support/canonical-scheduler-fixture.mjs`.
- `tests/tools/scheduler-committed-evidence-readback.test.mjs`.
- `tools/test-matrix/scheduler-committed-evidence-readback.md`.

Node24.16 API controls exit 0: 3 pass, 0 fail, 0 skip. The actual consumer command
uses the anchored pattern
`^ordinary committed final output consumes the actual scheduler API and retains the wrapper digest without qualification$`
and exits 0: 1 pass, 0 fail, 0 skip. The other 23 registered consumer callbacks are
unselected. Indexed closure inspection, changed ESLint, one-file Markdown and
bounded commit range exit 0. No held integrity/cohort/native acceptance was run;
these ordinary results do not grant terminal qualification. GitHub CI is disabled.

Refs: #2060, #2061, #1672

## Assigned issue WIP

All assigned issues remain OPEN. Both published source increments are concrete
ordinary capabilities; neither claims complete runtime acceptance. Per-issue
remaining gaps are in `issue-by-issue-gaps.json`. #1934 still needs the original
live grant adapter and actual sibling release to pending nested-child admission
timeline. #1965 still needs full Production cleanup/outcome acceptance. #1968
still needs global correctness-v2 consumer migration. #1969 and #1693 retain
held cohort/native acceptance. #2060's previously missing readback API source
composition is now genuinely verified, while production final commit and owner
integration remain OPEN.
