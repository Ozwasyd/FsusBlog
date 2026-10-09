# Private delivery / HTTP composition source handoff

Source WIP, not product/native qualification. Exact source candidate `37bcf36d857b6d73767246c8d160b8ed3592cf6c`;
base `c4bfd8dca103cb59f41f58a2e9618b2e3650073e`; branch `codex/chain-3653-private-delivery-20261009-r1`.
Latest fetched origin/master: `be7c53d99b64342925ca63d061bacde34d22ba4c`.
Source commit was pushed and remote SHA verified. Root alone writes GitHub content;
no PR/comment write, activation, merge, issue closure or deployment was performed.

## Actual usable composition

Five nonvisual frontend files are byte-for-byte from the supplied sole consumer
`4a55619a574e58ab17659ca9b2eb855d0b27e330`:

- `src/frontend/src/api/documentExport.ts`
- `src/frontend/src/components/document-export/documentExportCall.ts`
- `src/frontend/src/components/document-export/documentExportUiPort.ts`
- `src/frontend/src/components/document-export/documentExportWireUiPort.ts`
- `src/frontend/src/composables/useDocumentExport.ts`

`createDocumentExportBrowserUiPort(options)` in
`src/frontend/src/composition/documentExport.ts` consumes the original
`createDocumentExportWireUiPort`. The exact typed `catalog`, `sources` with
sole-generated coordinates, and `prepareRequest` remain mandatory authenticated
host inputs. No browser provider registry, source-version mapping, persistence,
request default or output success is invented.

The composition binds `deliverDocumentExportPrivate` in
`src/frontend/src/services/documentExportPrivateDelivery.ts`. This uses the actual
existing ContentTools Blob/anchor browser delivery pattern, checks AbortSignal
before URL/link creation and immediately before the click, and removes the link
and revokes its private object URL on success/refusal/interruption. A resolved
call means browser dispatch only, not an operating-system saved-file receipt.
The unchanged sole consumer owns real authenticated PoW transport, header/body
verification and admin-generation/cancellation checks. No grant or URL is returned
to UI. No real HTTP/private output was produced in this task.

`AddDocumentExportHttpTransport(services)` requires one existing scoped
`IDocumentExportFrozenSourceReader`, one existing scoped original
`IAuthorRecentArticleHistoryPermissionProjectionProvider`, and one existing
singleton `IHttpContextAccessor`. It refuses missing/duplicated registrations
before changes, registers the existing HTTP job authorization and invokes the
same original transport composition over sole Jobs. It creates no SQL authority,
permission default, full source reader or worker principal. General bootstrap and
routes/navigation remain inactive.

The original Shared3735 registry/enum/response-registration inputs are unchanged
relative to c4. No current-base registry fix is duplicated. The source increment
is11 paths relative to c4; only one C# file changes. Earlier frozen/HTML branches
and c4 remain unchanged.

## Current executable results and exact limits

On source `37bcf36d857b6d73767246c8d160b8ed3592cf6c`, SDK10.0.302 complete original Server test-project build:
exit0,1500 project warnings,0errors, changed C# paths0 diagnostics. Exact argv:

```sh
/workspace/chain3653-sdk/dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Release --no-restore --artifacts-path /workspace/chain3653-evidence/export-wire-integration-8464d96/backend-artifacts -p:RestoreLockedMode=true -p:FsusBlogCommitSha=37bcf36d857b6d73767246c8d160b8ed3592cf6c -p:NuGetAudit=true -p:NuGetAuditMode=all -p:NuGetAuditLevel=low --disable-build-servers
```

C# style, official whitespace verify, change-contract range and diff checks exit0
on this exact candidate. No C# unit/native/provider/Migration test was executed.
The prior audited locked SDK restore is source979cbc77f5028777508ab2a6fb1e08a6704decf0;
project/props/lock graph is unchanged; no new restore or full CI pass is inferred.

The exact29 original allowed Server cases remain **NOT_RUN**. Full selection,
arguments, FQN filter, actual unconditional call and original entry are in
[selected-server29-preflight.md](./selected-server29-preflight.md). The source
binding is preserved from the existing c4 preflight; no lane, alternate harness,
testhost or Migration rerun occurred. The canonical lane owner must supply an
admitted original selective entry, or explicit aggregate case identities/count
and isolated MySQL admission. The new HTTP DI helper has compile/source checks
only; no runtime registration qualification is claimed.

The new ten DOM delivery controls actually executed on preserved source
`cd73cccf184667b3300531b168a859669f0bbeda` with canonical Vitest config/setup:
10passed/10selected, exact positive multiset match, actual Vitest4.1.5. Current
lock requires4.1.11, so this is **EXECUTED_UNQUALIFIED_TOOLCHAIN_MISMATCH**,
not locked ordinary acceptance. This old source tree is byte-identical to the
corrected source above; its branch and raw JSON/JUNIT/log are retained. These
controls include pre/during-save cancellation, URL/link/click refusals, repeated
flows and cleanup; none is an API/native/output or disk-save acceptance case.

Official disposable `npm ci --ignore-scripts --no-audit --no-fund` was attempted
without changing package/locks. It exited1: GitHub Packages returned401 for the
locked `@ozwasyd/element-plus@1.5.1` URL. The real installed public dependency
attempt did not complete; no alternate package, auth bypass or lock rewrite was
used. Current frontend style exits1 at missing
`@vue/tsconfig/tsconfig.dom.json` after that failed installation; current10-case
rerun and application typecheck are **NOT_RUN_PACKAGE_AUTH_BLOCKED**. Prior
strict frontend style passed7files/0violations on the preserved identical source
with the previous dependency directory; it is not a current complete-toolchain
pass. Original local FsusUI checkout exists at
`f2b3bb89ffe5f749da26c388f058efdbb6aee864`; no new UI/public API/browser/native
qualification follows from its presence.

The prior source commit failed change-contract because scope `export` is not
allowed. It remains published, not amended or force-rewritten. The corrected
commit replays the exact tree with scope `api`, and its contract check passes.
Both compilation receipts and failures are preserved.

## Real remaining inputs

- An admitted original frontend setup with authorized access to the exact locked
  FsusUI1.5.1 package, then current locked ten-case/unit/type/lint verification.
- A real complete `IDocumentExportFrozenSourceReader`: formal site identity;
  exact draft document epoch / revision / publication / sourceVersion; original
  source/metadata/property seals; complete retained images/fonts and manifests;
  real renderer build identity; parser-proven no embeds or authorized retained
  plan/projection/codec/retention with independent expected digest. Original
  nonnull frozen-embed materializer refusal remains.
- Existing authoring draft response supplies serverRevision but no persisted
  document epoch/export version authority; revision/detail/release models have
  no full export closure. Existing compare/current-source readers are partial and
  bind primary/primary-site, not a portable formal-site export snapshot. No alias,
  digest-domain conversion or revisionNo/serverRevision substitution is guessed.
- A real authenticated export catalog/source projection transport. Backend
  ImplementationAvailable is source capability, not native admission. Therefore
  real format/source choices, preparation identity/locale, article navigation and
  DI/routes activation cannot yet be bound. No Shared frame is allocated here.
- Original worker live session/permission path; HTTP adapter denies absent context.
- Native sandbox CPU/deadline/cancellation/physical cleanup and final four-format,
  HTTP/private grant/download/browser/accessibility acceptance.
- Accepted3653 and sole3644 exact qualified3632/3634/3636 commits/evidence for3578.

Full11-issue accounting remains unqualified; no tracking parent was independently
implemented. Root completion does not imply chain completion.

Local command/log/provenance collection:
`/workspace/chain3653-evidence/frontend-consumer-integration-4a55619/`.
This is a portable source handoff, not a fabricated runtime receipt.
