## Linked Issue

Refs #3521

Related source ownership: [#1672](https://github.com/Ozwasyd/FsusBlog/issues/1672), [#1967](https://github.com/Ozwasyd/FsusBlog/issues/1967).

## Scope Summary

The supplied scheduler terminal source at `2eda290cc6098971b685b3fb1465d7193bd3dde2` still carried old execution-closure bindings, causing its SOURCE gate to refuse current targets. Run the original full canonical producer with Node24.16.0 and adopt its complete current-candidate output. The independent index, parser identity, target roster, owners and declarations stay byte/field equivalent; the generated fixture binds the actual updated source closure.

The canonical-owner increment changes two files relative to2eda: the producer-owned fixture and ordinary source/output relationship metadata. Its nine declared sources are actual source changes relative to master `aaba7b8c84ecfb336c71443e30d9fd82d21fb16d` and members of the producer-observed closure. The supplied terminal implementation is reviewed under its existing original owner; this increment does not duplicate that implementation.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none

## Tests Run

- [x] Other: original producer exits0 and matches the independently supplied fixture SHA256 `8611eb05a7762979be2db15520fdb55da92582f275927eb040b8412c70f0458d`.
- [x] Other: current published6ed505c7 SOURCE exits0 with93/93 controls,28 JS files and1 Markdown file checked.
- [x] Other: original boundary controls103/103 at published6ed505c7, repository check exit0, and full master-to-candidate commit range exit0. Original producer fixed point exits0 at published6ed505c7, with byte-identical output and a clean worktree.

## Generated Output

- Generator source: tools/release/correctness-provisional-receipt.mjs, tools/release/correctness-scheduler-authority.mjs, tools/release/correctness-terminal-receipt.mjs, tools/release/correctness-terminal-seal-journal.mjs, tools/release/test-evidence-receipts-cli.mjs, tools/test-matrix/correctness-input-manifest.mjs, tools/test-matrix/scheduler-correctness-finalizer.mjs, tools/test-matrix/scheduler.mjs, tools/test/bundles/bundle-steps.mjs
- Generated outputs: tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Binding manifest: artifacts/change-contract/scheduler-terminal-current-execution-generated-binding.json

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: bind terminal candidate execution closure

## Notes For Reviewers

This is a local integration draft for the content-write queue, not live GitHub PR metadata or an accepted PR contract. The original consumer PR must retain its own source ownership, required naming metadata, classifications and acceptance limits when incorporating this increment. No independent generated-only exception is claimed against2eda; ordinary source/output metadata is evaluated against the full supplied source candidate and master base.

The fixture is exact-candidate evidence. On another source tree, regenerate using `node tools/test-matrix/generate-release-final-execution-authority.mjs`; do not reuse this output or its hashes as a general authority. Historical replacement/promotion, SDK native owner, full runtime/cohort qualification and the global merge barrier remain unchanged. No public API, wire/ABI, database migration, auth/privacy or product behavior is changed by the canonical-owner increment.
