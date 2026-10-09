## Linked Issue

Refs #3735

Related to [#3653](https://github.com/Ozwasyd/FsusBlog/issues/3653). This source WIP does not accept or close [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736) or [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738).

## Scope Summary

- Add the exact current-master Export wire closure: existing roots278–281 and source Capture/Revision choices/Choices roots282–284. Preserve actual catalog50 choices/private512 bindings and independent Int64 coordinates.
- Source10b33204607627d167e34f7ad69bcfccaee03b2c, based on checked master9d72a1c93b297f719d8695a642cdfb1615cf1d51. Original existing Core models/codec remain unchanged; original244 master frames and five retained renderer oracle digests remain unchanged.
- Canonical endpoint owner3653 consumes the published Shared DTO/codec instead of a second source catalog or ordinary GET mutation.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [x] Public contract change
- [ ] External naming exception
- Contract impact: compatible

## Tests Run

- [ ] ./tools/test.sh fast
- [ ] Targeted backend tests: strict gate FAILED;11 new managed bodies and executable discovery UNRUN.
- [x] Targeted frontend checks:57 Node controls,1176 production native dispatcher rows,21 original protocol negative controls, exact count+1 native controls and task cleanup. Style11files0violations; three canonical producer checks0.
- [x] Other: original Core build7ca exit0/188warnings/0new-path diagnostics, two original generated-module TS strict checks7ca exit0 using actualTS6.0.2. Exact production blob equality with10b is recorded without rebinding evidence.

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
- [x] .git-blame-ignore-revs updated when applicable
- Formatter identity: repository ESLint/generated formatter and official dotnet format whitespace
- Formatter version: actual tool identities in artifacts/shared-export-source-options/tooling.json
- Formatter command: exact logged scoped repository commands
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: none

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] Cross-language coding conventions reviewed
- [x] Document lifecycle updated: stable contract current, this draft handoff proposed
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
- Non-goals: runtime latency/capacity claims

## Release Note

- Audience: internal
- Category: Added
- Summary: add canonical export source options wire closure

## Generated Output

- Generator source: tools/frontend/generate-aeds-protocol.mjs; tools/contracts/generate-document-export-wire.mjs; tools/contracts/generate-document-export-source-options-wire.mjs
- Generated outputs: original five AEDS products plus two TS/native products per Export family, all from their canonical source producers
- Digest/evidence: artifacts/shared-export-source-options/run-evidence.json (actual run evidence; formal generated-output binding remains a separate required gate)
- Automation identity: none

## Rollout / Rollback

- Rollout: draft review only; canonical3653 must integrate actual write/PoW endpoints and independent runtime evidence. No merge/deploy.
- Rollback: keep masters/frozen branches unchanged; withhold this isolated source until complete qualification. Do not recycle already allocated IDs.
- Deferred work: actual managed bodies after strict gate, catalog PostgreSQL, HTTP/session/PoW, native Wasm qualification, full frontendtypes and renderedUX.
- Known limitations: current master dense goldenOrder244–250 differs explicitly from frozen full-registry269–275, while wireIDs278–284 and existing layouts remain unchanged.

## Notes For Reviewers

Requested draft title: `feat(shared): add canonical export source options wire closure`. Base `master`; head `codex/shared-export-source-options-current-base-20261009`. Parent remains the sole GitHub API writer; this is a reviewable publication request, not permission to merge.

UI checkboxes do not imply rendered product acceptance; no UI composition changes occur in this wire-only increment. Database review confirms no DDL, production access or binding-retention change. Formatting-only qualification/blame-ignore is not claimed; exact original632 brace delta is a separate commit. Original c07 package export delta is reused, with no wrapper, new dependency or import suppression.

The original renderer function and all five independent retained hashes remain unchanged. Only canonical CLI TS output is styled. All21 original negative controls remain intact, and original expected count/future append order are updated solely for the seven genuine new roots.

Formal generated-output-binding metadata and full independent qualification remain pending; the run manifest is not a replacement seal. No CI/audit threshold relaxation, bypass, alternate backend testhost, denied CI retry or held receipt replacement was performed.
