## Linked Issue

Refs #3521

Related independent acceptance review: [#3594](https://github.com/Ozwasyd/FsusBlog/issues/3594).

## Scope Summary

Current master has eight duplicated historical identities with conflicting replacement sets. Consolidate each identity once, retaining the exact union of both original sets and both reason texts. Preserve all other entries, assertion replacements, frozen before identities, matrix membership, transaction history and unchanged conflict-refusal code.

This is the existing canonical correction rebound to master cb6f4e4a, not new3594 implementation or historical admission. It changes only tests/test-retention-replacements.json. Baseline original controls reproduced39/40; exact published b70d3115 now passes40/40 with zero skips. Range and diff checks pass.

## Notes For Reviewers

This is a local integration draft for the GitHub content-write queue, not an independently accepted PR contract. The declarations' original reason claims are preserved as declarations, not promoted to current PostgreSQL/runtime quality evidence. The separate35 Migration/Audit replacement references, current compiled after-inventory, SDK/native owner, history promotion and global merge barrier remain outstanding.
