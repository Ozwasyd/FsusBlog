Proposed increment title: `style(aeds): expand protocol negative-control braces`.
Draft, target `master`, parent is the sole PR writer. This is the full template proposal for the minimal source increment; it is **not submission-ready for the inherited branch aggregate**. That aggregate has 155 paths against known master c04 before these evidence additions and includes earlier behavior/contracts. The parent must consume the exact minimal commit and adapt the whole-PR scope/classification to the actual consumer composition. No PR or metadata gate success is claimed.

## Linked Issue

Refs #3735

Related to [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736), [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738) and [#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325). All acceptance remains open.

## Scope Summary

- Apply the original ESLint formatter to the 21 existing protocol rejection callbacks, removing 63 brace diagnostics. Source `6324264ab60fbf6b196f14c09a447eca58402bbe` changes only `tests/tools/aeds-protocol-generation.test.mjs`, based on frozen 0015897.
- Keep all existing test assertions, historical digests, negative controls, original producer and five products. This increment does not rewrite the existing import diagnostic or change any checker/config.

## Change Classification

- [ ] Behavior change
- [x] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none for the minimal source increment; format qualification is blocked, and inherited branch classification must be handled independently before submission.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests: unrun; no backend change in this increment.
- [ ] Targeted frontend checks: broader frontend types/build unrun.
- [x] Other: original Node24.16 runner at `6324264ab60fbf6b196f14c09a447eca58402bbe`, exact 36 selected and executed, 36 pass / 0 fail / 0 skip; original producer `--check`, five outputs in sync, exit 0; syntax and diff checks exit 0.

Original strict style: 64 before, 1 after. Both formatter passes exit 1 for the unchanged parent import rule; their bytes are idempotent. Original pinned-parser equivalence exits 1 ENOENT, without fallback. Full gate remains unaccepted.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [x] Accessibility and reduced-motion impact considered

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [ ] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: eslint
- Formatter version: 10.8.0
- Formatter command: /tmp/chain-3735-tooling/node24.16/node-v24.16.0-linux-x64/bin/node tools/frontend/check-frontend-style.mjs --mode strict-full --file tests/tools/aeds-protocol-generation.test.mjs --fix
- Formatter idempotence evidence: artifacts/shared-protocol-format/idempotence.json
- Blame-ignore revision: 6324264ab60fbf6b196f14c09a447eca58402bbe

## External Naming Exception

- Exceptions manifest: none

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] Cross-language coding conventions reviewed
- [x] Document lifecycle updated: this handoff is evidence, not a maintained authority
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: performance, runtime, whole-chain or inherited-closure acceptance.

## Release Note

- Audience: none
- Category: none
- Summary: none

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: draft source preservation and exact commit consumption only; no deployment or merge authorized.
- Rollback: revert only the mechanical source commit if required; keep evidence and contract failures reviewable.
- Deferred work: canonical pinned-parser equivalence, later blame registration, separate lawful import correction, actual aggregate PR metadata and full acceptance.
- Known limitations: strict style residual 1; pinned parser unavailable; branch inherits unrelated consumer source not requalified here.

## Notes For Reviewers

Public API documentation, intent and security checkboxes mean reviewed as not applicable to this increment; no corresponding contract changes were made. No new TODO/FIXME exists. UI evidence is not applicable to callback whitespace. The five historical expected digests and producer/products are unchanged; current original tests pass, but full raw-token/AST/literal/comment equivalence is not asserted without the canonical comparator. The blame checkbox remains unchecked by explicit parent direction while equivalence is blocked. The actual aggregate master-targeting PR cannot be called format-only using this increment-only proposal. There were no GitHub content API writes, held audit attempts, installs, config relaxations, alternate harnesses or issue-closing actions.
