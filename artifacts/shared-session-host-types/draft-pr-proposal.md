## Linked Issue

Refs #3735

Related to #3736 and #3738. All remain open.

## Scope Summary

Contextually type the frozen authoring session resource policy and replace non-erasable constructor parameter properties with explicit readonly fields. Preserve assignments before the existing policy validation.

## Change Classification

Minimal frontend typing correction; seven insertions/three deletions in one source file. Not a format or naming migration.

## Tests Run

Changed-file canonical style PASS at 13b35b7350c25796bd231c1b8193044a579d2d34. Original canonical full application typecheck FAILED at d8662bb6c3cb012076bbdfa7dd24ab3b92eaf3dd:232 diagnostics, zero in the target file. Exact21 original unit cases BLOCKED before bodies: missing @noble/hashes. Logs and actual command identities are in artifacts/shared-session-host-types.

## UI Evidence

No observable UI change or rendered UI acceptance claim. Runtime and UX gates remain open.

## Coding Convention

Existing TypeScript declarations and indentation preserved. No casts, stubs, configuration relaxation or generated output edits.

## External Naming Exception

None introduced.

## Documentation / Intent

Evidence and precise remaining dependency/typecheck limits accompany the one-file change. Public signatures and existing lifecycle contracts remain unchanged.

## Compatibility And Risk

Factory/policy assignments remain before verification; default parameter and field initialization order retained. Full frontend types and original units remain unaccepted until the canonical dependency environment is available.

## Performance Claim

None.

## Release Note

Developer typing compatibility only; no release or deployment performed.

## Generated Output

None edited. The existing local typecheck producer wrote its ignored task project only.

## Rollout / Rollback

No rollout performed. Revert the one source delta if canonical ordinary controls show a regression; preserve external acceptance gates.

## Notes For Reviewers

Base master c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f; source 13b35b7350c25796bd231c1b8193044a579d2d34; source tree 9f614d59367c8a8144f0b46054e27205dec1da1d. Earlier commit d8662bb6c3cb012076bbdfa7dd24ab3b92eaf3dd has an identical tree and remains retained, while this canonical branch has valid commit metadata. Parent is the sole PR writer. No denied workspace-race audit was retried. No merge/close/auto-merge/deployment.
