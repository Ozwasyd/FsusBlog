## Linked Issue

Refs #3735

Related to [#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325) and [#1889](https://github.com/Ozwasyd/FsusBlog/issues/1889). Source WIP; all issues remain open.

## Scope Summary

- Current-base isolated branch `codex/shared-transport-style-20261009` preserves the shared rejection object and cleanup/cancellation sequence while fixing the two original transport style diagnostics. The inaccurate Error annotation is superseded by a synchronous shared completion handler, forwarding the native reject callback with `unknown`. Compared with supplied consumer `7b374e71f89433cf04e5e315fdd1d43816728f85`, the final product has exactly the two completion-handler hunks; its canonical `location.href` and explicit proof-option consumption are retained. Existing Draft PR [#4094](https://github.com/Ozwasyd/FsusBlog/pull/4094) receives the owner branch increment.
- Complete PR scope from base `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`: **42 paths**, comprising the one product transport file, one supplemental test owner, and 40 public ordinary evidence/handoff/proposal files. Latest inspected master is `a281fb6e9802471c3a44569c3ccab84f88c8d816`; the branch base is unchanged. [Complete scope](https://github.com/Ozwasyd/FsusBlog/blob/codex/shared-transport-style-20261009/artifacts/shared-transport-style/unknown-rejection-followup/scope-manifest.json). No inherited Canvas/registry/property/Font/theme implementation or consumer branch import is hidden in this scope.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none; existing runtime rejection values, binary/auth/proof and fetch behavior preserved.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests: not applicable to this frontend transport source change.
- [x] Targeted frontend checks: original 24 and owner 10 regressions, **34 passed / 0 failed / 0 skipped**, at exact source `d61f0977e1f8a45873ac33122c028461d22e5a80`, on Node24.16.0; original-project Vitest4.1.11/configuration/setup retained. Before execution, exact nonempty positive full-name selection/count and all15 hooks were verified; held0. No diagnostic host was run. Older30-case reports retain their older source binding only.
- [x] Other: original changed-style entrypoint, complete touched product file, Node24.16.0 / ESLint10.8.0 / typescript-eslint8.65.0, exit0 / files1 / violations0. Original test file remains byte-exact master. [Source, argv and raw reports](https://github.com/Ozwasyd/FsusBlog/blob/codex/shared-transport-style-20261009/artifacts/shared-transport-style/unknown-rejection-followup/run-evidence.json).

Product plus supplemental test `git diff --check` exits0. Complete branch plus staged follow-up evidence `git diff --check` exits2 for preserved raw ANSI-log trailing spaces/terminal blank lines and three unified consumer patch blank-context lines. Product/test scope exits0; raw bytes remain unchanged; no full-branch whitespace gate pass is claimed. Full frontend types/build/CI and exact final whole-head qualification are UNRUN. Failed setup/install/style attempts and two stopped follow-up preflights remain in public evidence; they are not relabeled passes. Supplemental test TS lies outside configured product style sets.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

No rendered UI change or rendered acceptance is asserted by these ordinary transport controls.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: ESLint with existing repository rules; ordinary check, no format migration
- Formatter version: 10.8.0; typescript-eslint8.65.0; Node24.16.0
- Formatter command: `node tools/frontend/check-frontend-style.mjs --mode changed --base a281fb6e9802471c3a44569c3ccab84f88c8d816 --file src/frontend/src/api/binaryApiClient.ts`
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: none

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

Public API semantics are unchanged, so normative API docs require no update. The [ordinary source handoff](https://github.com/Ozwasyd/FsusBlog/blob/codex/shared-transport-style-20261009/artifacts/shared-transport-style/unknown-rejection-followup/handoff.md) records ownership, rejection semantics and limitations. No TODO/FIXME is introduced.

## Compatibility And Risk

- [x] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [x] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

These are bounded author source reviews, not independent product acceptance. No wire/ABI/database identity changes; database migration is not applicable. Original binary, proof, credential stripping and cancellation controls pass at d61f0977e. Full application and independent verification remain open.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no latency, allocation, throughput or production performance claim.

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: preserve binary transport rejection and option semantics

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: draft source handoff only; parent remains sole GitHub content writer. No merge, auto-merge, deployment or issue closure.
- Rollback: revert the bounded transport increment on its owner branch before coordinated integration; preserve subsequent consumer changes and canonical URL handling.
- Deferred work: consumer2325/1889 integration on exact resulting commits; full required types/build/CI and independent runtime/UX acceptance.
- Known limitations: current source receipts remain bound to d61f0977e; later evidence commits are not a whole-head rerun. Held audits remain stopped.

## Notes For Reviewers

No independent module owner is added. All current frozen registry/Canvas/consumer heads remain unchanged. The original Error/AbortError and exceptional non-Error rejection identities, listener cleanup, one/final waiter cancellation, late failure and immutable option stripping are exercised; the completion adapter performs no runtime coercion/error replacement, extra promise/microtask or new runtime API. Primitive/null/undefined/object reasons are admitted without asserting Error.

Raw test reports are ordinary execution evidence, not canonical generated source products; generated-output metadata is not applicable. Blame-ignore and format-idempotence evidence are not applicable because this is no format-only migration. No UI, database or external naming exception is introduced.

Next original commands are in the public handoff: install the existing locked toolchain/test dependencies, run the exact one-product-file changed-style check and the original plus supplemental two-file Vitest invocation from the original frontend package/configuration, only after exact nonempty positive full-name selection/count and every hook are verified. Failed preflight or selector/count mismatch stops before execution; held cases must not execute. Require all34 positive-selected controls, zero failures/skips and zero touched-file style diagnostics at the actual consumer source before claiming this increment consumed. Whole issue acceptance also requires the still-open original runtime/types/CI/independent gates; no narrow result approves broader branches. Consumer dependencies are public [#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325), [#1889](https://github.com/Ozwasyd/FsusBlog/issues/1889) and the supplied [7b374e71 source](https://github.com/Ozwasyd/FsusBlog/blob/7b374e71f89433cf04e5e315fdd1d43816728f85/src/frontend/src/api/binaryApiClient.ts). The original consumer419 controls are separately reported at that SHA, not rerun or rebound here. A consumer-specific two-hunk patch was checked on a disposable copy and yields the exact tested product blob; no sibling branch was edited.
