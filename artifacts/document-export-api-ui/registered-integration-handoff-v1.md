# Registered Export consumer integration — source WIP

Branch: `codex/export-api-ui-2436-wire-integration-20261009`.
Usable consumer/test commit: `302836f03e43fcdad3d709e3b8fc828a0180501c`.
Exact Shared source: `71179da783bae459b665b1ca168a97b718b4b01b`, consumed at
`e04d4afe30b5b8b2c0191c96f0ae4eafe5ddece5`. The separate integration branch
starts at frozen wire consumer `4a55619a574e58ab17659ca9b2eb855d0b27e330`
and includes actual master `be7c53d99b64342925ca63d061bacde34d22ba4c` through
`1130f9cee9f2330c6e32c5692c69552c6670f6fd`. Frozen 6402, frozen 4a556 and
final 37-file candidate 51fd remain unchanged; their final SOURCE slot is separate.

## Real registration closure consumed

All 158 owner-changed paths, including deletions, have exactly the 71179 Git blobs
and modes. Twelve paths were already identical in the frozen consumer; the
consumption commit changes 143 nondeleted paths and deletes three paths (146 total). The sole add/add generator conflict was
resolved by consuming the complete original 71179 file, without hand editing.
No Shared registry, native validation or producer was independently changed.

This brings actual typed prerequisites 253–277 and Export 278–281, 273 contiguous
golden records with Export positions 269–272, native error 18, both existing unique
response registrations and the owner's producer/source/template closure. It
does not merge the original owner's complete integration branch. The later
39589 Canvas layering repair is separate and is not included here.

The unmodified Export producer `--check` now passes under verified official
Node 24.16.0. The previous missing-registration failure is historical and solved;
there is no remaining `reservedFrameValues` prerequisite for this consumer.
The owner validates exact active roots when the reservation property is absent;
missing roots and malformed/wrong-owner reservations still refuse.

WritingAid's changed negative fixture is an input correction from `18 00` to
`19 00`, because 18 is now the actual registered Export error. The native values
remain WritingAid 15 and Export 18. The original fixture parser still rejects
expected-error values greater than 18 with exit 2; refusal semantics are preserved.

## Usable domain APIs and original-owner composition

The existing owned client `src/frontend/src/api/documentExport.ts` exports
`requestDocumentExport`, `listDocumentExports`, `getDocumentExport`,
`cancelDocumentExport`, `retryDocumentExport`, `deleteDocumentExport`,
`downloadDocumentExport`, `captureDocumentExportRequest` and
`classifyDocumentExportFailure`. It consumes the actual registered enum and sole
generated codec through original authentication/PoW/private-generation transport.
Uncertain writes retain the original request/idempotency identity. Downloads
check identity/cancellation before body read and before the required save callback.

`createDocumentExportWireUiPort({catalog,sources,prepareRequest,deliverPrivate})`
connects those typed APIs to the existing accessible export center. No consumer
or response-registry replacement is needed after this closure. Original #3653
supplies authenticated canonical catalog/source choices; sources include exact
`DocumentExportSource` coordinates. Its request adapter must return the actual
closed request/source/options/locale and request/idempotency identity. The caller
uses that port with existing `ExportCenter.vue`; original #3653 owns the navigation
and route wiring. API/UI does not independently write those integration files.

Remaining original backend port:
`IDocumentExportRequestFreezer.FreezeAsync(HttpContext,DocumentExportJobActor,
DocumentExportRequestCoreModel,CancellationToken)` returning the canonical sealed
`(DocumentExportTask,DocumentExportFrozenInput)`. It must recheck actual source,
site and session permissions through original authorities and the existing builder.
The real session/source/site permission adapter, DI/HTTP activation and sole Jobs
composition remain original #3653's domain. No fallback freezer is provided here.

The original private saver receives `{bytes,filename,mediaType}` plus the admin
lease signal and must honor that signal through its actual save boundary. The API
does not invent a default saver, grant, token URL, storage path or successful output.
Wire parsing and displayed snapshot facts never authorize download independently.

## Verification on this integrated source

- Frontend 126/126 in exactly seven positively selected owned files: previous 119
  plus seven new registered-consumer cases. Actual case multiset matches preflight.
  New cases use the real frame enum, original response registry and generated
  codecs. Only their outer HTTP/native admission boundary is controlled; no
  successful job/output/receipt is manufactured. The first run was 124/126 because
  the new beforeEach returned a mock function, which Vitest invoked as cleanup
  without arguments. The hook was repaired and the same 126-case run passed. The
  failed raw log is retained; its original JSON report was overwritten by the
  canonical rerun and is unavailable.
- Export-specific Node 19/19 in exactly `document-export-wire.test.mjs` and
  `document-export-registration.test.mjs`; the actual C++ DecodeFrame dispatcher
  was compiled and checked against 940 actual positive/adversarial inputs. Native
  case/count/raw-output artifacts were inspected. Borrowed views, exact budgets,
  flags, CRC ordering and error 18 are tested by the original owner fixture.
  Its unchanged stdout utility label mentions error 15; the 940 checked Export
  inputs and expected-error 18 assertions establish the actual scope.
- Fresh managed 21/21, zero skips, in the seven explicitly selected methods of
  `DocumentExportEndpointBindingTests`; actual TRX case names match the original
  positive roster. This compiles actual Shared/Core/Server and the ordinary test
  assembly with real active enums and consumer binding. Locked restore passed
  with NuGet audit enabled; NU1903 and build warnings are retained. It is not
  private authenticated HTTP or provider-output qualification.
- Full canonical FsusUI application typecheck remains FAILED with 237 diagnostic
  lines, exactly equal to the verified prior wire consumer; introduced 0,
  resolved 0, Export 0. No full-type pass is claimed.
- Chromium 1366x768 desktop/light and 390x844 mobile/dark/reduced-motion checks use
  real FsusUI f2b3bb89 and actual registered frames 278–281. A controlled literal
  queued golden supplies the displayed source fixture; no HTTP job is created.
  The original client actually requests the task-local PoW challenge and receives
  HTTP 404, clears private rows/form, and sends no Export request. There is no
  response interception or successful reply. Both screenshots were inspected,
  with no overflow or page errors. Two expected 404 console messages are retained.
  This is actual negative HTTP behavior, not valid session/PoW/server or native
  Wasm/worker admission qualification.

The sole owner's reported 12 generator checks, 374 managed cases, 940 native inputs,
seven standalone codec typechecks and earlier compilations are source-specific
owner evidence. They are not claimed as executions on this consumer candidate.
This task's fresh evidence is the bounded list above.

## Exact checks and frozen SOURCE plan

Official Node executable:
`/workspace/export2436-evidence/node-v24.16.0-linux-x64/bin/node`.
Its binary SHA256 is
`b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd`;
the official archive checksum and extracted binary equality were reverified.

```sh
node tools/contracts/generate-document-export-wire.mjs --check
node --test tests/tools/document-export-wire.test.mjs tests/tools/document-export-registration.test.mjs
```

Frontend command from `src/frontend`:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  ../../tests/frontend/unit/api/documentExport.test.ts \
  ../../tests/frontend/unit/api/documentExportWireConsumer.test.ts \
  ../../tests/frontend/unit/api/documentExportRegisteredConsumer.test.ts \
  ../../tests/frontend/unit/components/DocumentExportCenter.test.ts \
  ../../tests/frontend/unit/components/DocumentExportRejectedAction.test.ts \
  ../../tests/frontend/unit/composables/documentExportWireUi.test.ts \
  ../../tests/frontend/unit/composables/useDocumentExport.test.ts
```

Managed methods: `AnonymousActor_RejectsWithoutFreezingOrReadingFrames`,
`CancelledActor_RejectsBeforeAnyAuthorityRead`,
`FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization`,
`FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses`,
`FrozenAdmission_PreservesOriginalAuthorityAndSealedBytes`,
`FrozenAdmission_RejectsAnyMismatchWithoutResealing`,
`FrozenAdmission_RejectsChangedInputDigestRatherThanRepairingIt`.
Each uses an exact FullyQualifiedName filter, not a broad class prefix.

Candidate 51fd is preserved in [draft PR #4040](https://github.com/Ozwasyd/FsusBlog/pull/4040).
Required SOURCE is not yet validated. Root's final FIFO gate plan for 51fd is
unchanged; no early rebase/declaration/plan/gate repeat occurred. Prior broad HELD
applicability classification was withdrawn: the reviewer reports three SOURCE
coordination tiers, sourceRegressionTargets=[], 26 C# and 4 UI sources for that 37-file
candidate. Actual plan must still be confirmed at its authorized slot. No full,
qualification, held audit or aggregate was executed by this integration work.

## Remaining runtime boundary

Actual authenticated server requests, real source/permission/freezer/session
lifecycle, real provider output and receipts, private grants/download saves,
browser native Wasm/worker admission and assistive speech remain OPEN. The exact
registration gap is solved; these are separate real original-owner interfaces.
The Int64-newline allegation was disproved and withdrawn; no patch was made for it.
Issue #2436 stays OPEN. Root alone writes GitHub content APIs. This task did not
dispatch remote CI, merge, deploy, publish packages or weaken any guard.
