Title: fix(shared): restore complete current-base private wire registration
Base: master
Head: codex/shared-registration-current-base-20261009
State: draft, source WIP
Creation/update owner: coordinating parent (sole GitHub content API writer)

## Linked Issue

Refs #3735

Related to #3736 and #3738.

## Scope Summary

Current master has 244 AEDS registrations and lacks the real 253–277 prerequisites
for Export 278–281. This bounded port preserves original IDs and golden order,
includes canonical Shared/model/managed/native/TypeScript/producers and the sole
response registry, and handles absent Export reservations with controlled refusal.
Canvas domain types move unchanged to Shared while existing Server implementations
remain the sole authority. The additional Canvas contract-layer fix generates its
budget section from the same Shared constants and removes the rejected runtime
import without changing any wire product or the strict original layer rule.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [x] Public contract change
- [ ] External naming exception
- Contract impact: compatible allocated private wire roots; source WIP, no endpoint activation

## Tests Run

- [ ] Complete canonical CI/qualification: OPEN
- [x] Targeted backend codec tests: explicit eight-class project, 374 passed at source 71179da
- [x] Targeted frontend/tool checks: 71 protocol/Export, 90 prerequisite wire, 8 pure property codec cases
- [x] Other: real C++ Export dispatcher 940 inputs; twelve generators checked; seven standalone wire TS files
- [x] Canvas layer: 32 Node controls, original 13-case Vitest owner, generator and two-file TS checks at af301b7
- [x] Core/Shared and Server compile successfully with 191 / 135 warnings, before commit on the subsequently captured source

## UI Evidence

Runtime/session/HTTP/Postgres/provider/rendered UX/full frontend acceptance remains
OPEN. Scoped pure controls and the actual original layer-rule negative are source
behavior evidence. No rendered product acceptance is inferred.

## Coding Convention

Generated changes come from their canonical producers. Three Canvas wire products
remain byte-exact through the layer fix. Full style and independent review remain
OPEN; existing warning logs and failed setup/control attempts are retained.

## Documentation / Intent

The current AEDS protocol document explains typed ownership, allocations, guard
order and the generated contract budget section. Exact source provenance, argv,
raw logs/TRX and acceptance limits are under `artifacts/shared-registration-current`.

## Compatibility / Risk

No original frame ID, golden order, retirement/header/privacy metadata or Int64
semantics changes. No invented reservations, request-as-response decoder, JSON
fallback, duplicate Server implementation or FsusUI exception. No 2436/3653 source
is copied; supplied consumers are inspected read-only. Full product qualification
and original required CI are outstanding.

## Performance

Existing finite payload/count/string/aggregate bounds and zero-copy native views
are retained; scoped codec tests exercise maximum payloads and malformed bytes.
No throughput or runtime performance qualification is claimed.

## Release Note

No release: private wire/source integration remains draft and WIP.

## Generated Binding

Protocol manifest plus its original five-output producer; seven canonical wire
owners/producers and the real upload POD owner. Layer change extends the sole
Canvas producer to its marked client-budget section. `source-provenance.json`,
`run-evidence.json` and `canvas-layer-run-evidence.json` bind tested candidates.

## Rollout / Rollback

No deployment, public route/bootstrap activation, merge, issue closure or auto-merge.
Review on this isolated branch. If owner/ID/guard drift is found, keep dependent
integration blocked and revert this branch's bounded source port before deployment.
Frozen Shared/Export/consumer candidates remain untouched.

## Notes For Reviewers

Whole #3735/#3736/#3738 acceptance and the retained 70-item queue remain OPEN.
Original failed attempts are not relabeled passes. Parent must create the draft PR
and perform later cross-chain conflict resolution only after the global barrier.
