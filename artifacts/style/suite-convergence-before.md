# Suite-convergence style before evidence

Issue: #3593. This is a read-only seal of current `master` at
`b19b3dc715691b871f0e3cab598ec5da8f27633c`; it does not admit debt or change
the style policy.

| Authority | Git blob | SHA-256 |
| --- | --- | --- |
| `tests/tools/test-suite-convergence.test.mjs` | `8deee0b5a3f74794b53c6290cab7692f82ccab3c` | `836d8301e31a4e16aa3ee2e37333aacfdcb6611415baec5733eec0958eda7189` |
| `config/development/frontend-style-policy.json` | `d5ae39652071899d9eb10529b57bfc0680d85acf` | `68f70a1e37e02746ba556bcb6fd6c7765df59b4f6137bac14246d2333373af85` |
| `config/development/frontend-style-rule-registry.json` | `e21a0422d4ed15ad85273e44eed67d78b595ad5d` | `e8636e01c088c3a0f08769b1c4e086eee55b54527ce8659db2bdde9d1d2977a3` |
| `config/development/frontend-style-baseline.json` | `54f72b80a36a9c4cb1d0a6d29418d77c5faad2b2` | `65e8d1930aa8e4830602aa7774862aeb65b79c19e3279deb3897804e23aab4e0` |

The baseline entry for this exact source records 548 diagnostics with digest
`e3f71df8b466b55f7d2719415a8bff7529969571dcc37ebdc06a27555217045b`:
398 indentation, 128 semicolon, 16 brace-style, three import-order, and three
parent-import findings. The test file has 16 discoverable Node cases at this
revision. An unsuppressed ESLint run and the exact-master style checker both
report the debt; the checker does not accept the stale aggregate.

The baseline was last updated at `b74b9f08208c4e6faea317432a8c5929f988a721`.
Its `sourceStateSha256` matches that commit's tracked tree at
`c2912bb087299da5768ba3c9e3ba8474d254f99e66a3227c62abaf1c3238b2c5`.
The same tracked-tree calculation at current master is
`07ef9084047d7d0fcf3774972cb3a3a61058a5b87f8815c9b0bf0511b8cf33d8`.
The checker intentionally discards the baseline map when those identities differ.

This evidence is a before-state record only. Admission requires independent
review of a separate token-equivalent format commit, the semantic import
boundary, current diagnostics, and the current-master gates.
