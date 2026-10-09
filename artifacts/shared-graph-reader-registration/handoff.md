# Graph/current-root integration handoff

Related to #3735, #3736, #3738, #2474 and #2324. All remain open.

Final source `bdf724ba4f1f25e9f2f433266577b2221b2d1af2` adds an ordinary resource-path repair to host source `999d96e6319124ac796db3e7966ec6b662b3433d`, which follows composition `843db5da008358038305ee02f6df7df094585211` on `codex/shared-graph-reader-registration-20261009`, based on evidence `bdf1c5d793afc09f9f1ed907dcc9f571a5870d39` and freshly fetched master `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`. The initial composition changes16paths; the host increment changes4paths. Full source diff from master49paths includes prior canonical coordinate/generation/property source and evidence; do not describe it as a four-file master PR.

## Actual root implementation

`ArticleGraphCurrentArticleHost` derives the owner from actual authenticated admin claims plus the canonical configured site; requires ArticleWrite and actual admin session; refuses fixed historical transactions other than ReadCommitted. It retains one version7-correlated request, calls the original reader, performs complete fresh revalidation, and returns the NEW admission only after request/principal/owner/session/permission-set/transaction rechecks. It supplies no runtimeDocumentEpoch, graph expansion, index, lease-use authority, endpoint or permission inheritance to neighbours. These remain original integration responsibilities.

Only one scoped SqlArticleGraphAdmissionReader and one scoped ArticleGraphCurrentArticleHost are added beside existing pin providers. Existing coordinate authority, permission provider and article source remain their sole registrations. The original registration control now also resolves the host and exercises its actual missing-request refusal. Thirteen new ordinary controls cover invalid actual context, historical transactions, actual64bit owner/correlation and cancellation; they are unrun, not claimed passed.

## Exact owner deliveries consumed

- Original3654 minimal `7b5ddc3ba5b25f281ab1cc574946544cbf5ca796`: shared revision RETURNING reader is disposed before original coordinate provisioning in the same caller transaction. Blob `968d8179278cd5b5ce760cdbc8c5c3f613428bda` equals tested/published `c65fc8a0f5efc13d87ac030fbf4734737e65d885`. This is no longer a missing writer. Original7unit+17PG PASS are producer evidence only.
- Graph/coordinate10files equal final `020274069153c92725c7c9e5231c88b3415ff6ee` exactly. Parent reports original106controls PASS0skip:22readerunit,64readerPG,6coordinateunit,1definition,13coordinatePG. Its original fixture cleanup is producer evidence, not a root receipt.
- Property unit repairs f1cc1f1 +37cf5ff consumed exactly. OldCS8620/staticOwnerIDE1006 are absent from current results; original assertions and identities preserved.
- Native matched3files from4a2124d/e4ac73 consumed exactly. Original audited locked restore now exit0 with zeroNU1903 in this root.
- Supplied1630a1 five-file ordinary membership closure consumed exactly;124class/963case result belongs to its original provider source, not this larger root source.

## Current verification

Original audited locked restore at843db5 exit0. Original strict test build at843db5 and `999d96e6319124ac796db3e7966ec6b662b3433d` each exit1/1508distinct errors. Root4files and selected supplied reader/hook/provider files have zero diagnostics; strict build remains FAILED. The root ordinary/default build was not run, so this does not establish default compilation failure. Parent reports current provider8746 default build exit0/0errors/1508warnings and strict1508warnings elevated; its15cases remain UNRUN. No error-threshold, alternate testhost, relaxed analyzer/audit or looser rebuild was used. Binaries emitted by the failed gate were not used to execute controls.

Root4file whitespace verification at `999d96e6319124ac796db3e7966ec6b662b3433d` exit0. Original static membership checker at843db5 exit1, naming three absent manifest members: ArticleRelationSourceCoordinateAuthorityIntegrationTests, ArticleSourceGenerationAuthorityIntegrationTests and SqlArticleGraphAdmissionReaderIntegrationTests. Exact14positive root rows are in host-preflight.json; all14test bodies and executable discovery are UNRUN. No rootPG/HTTP/browser/UX/native qualification was attempted.

One initial direct formatter invocation omitted the documented data wrapper and failed before formatting with read-only /home/agent/.dotnet. The safe original wrapper plus task data root corrected setup; no escalation or external-directory write was used. The precommit whitespace record is identified as such; current committed verification is separate.

## Ordinary resource-path repair

Sourcebdf724 replaces the property control's manual AppContext/slnx repository search with the real existing BackendTestPaths.ReadAllTextFromRoot API. The original assertions and two InlineData rows remain unchanged; both rows are UNRUN. The unchanged original backend-evidence-path authority producer was reviewed for actual hooks and resources, then --write and --check each exited0. Only its matrix source digest changed, with no inventory entry, checker, matrix, baseline or receipt rewrite. Path-scoped original wrapper whitespace verification atbdf724 exits0. The producer run binds to its actual precommit candidate with sourceParent999, while whitespace binds to committedbdf724. No broad suite/fullbuild rerun was made for this ordinary two-path fix; held audit/lane mutation work remains untouched.

## Shared consumer conflict and smallest owner action

Final Graph020 manifest would remove ArticlePropertySavedViewDependencyProviderIntegrationTests; its full tree retains older native inputs, undoing the explicit3file fix. Shared conflicting paths: tests/backend/Fixtures/postgres-test-collections.json, tests/tools/check-postgres-test-collections.test.mjs, docs/testing.md and artifacts/change-contract/postgres-collection-manifest-naming-exceptions.json. Those replacements are paused; no local count/assertion/merge repair is made. Original3657 must supply an exact closure for root `999d96e6319124ac796db3e7966ec6b662b3433d` containing the three new PG classes while retaining property membership and current native inputs.

## Remaining gates

The immutable coordinate FK/trigger conflicts with physical permanent deletion; Vault generic portable identities do not satisfy canonical article:UUID import binding; current schema extractor hardcodes FK actions to no-action and cannot express supplied RESTRICT/immutable effects. Original schema/lifecycle/import owners must align these contracts. Shared revision hook is DONE/consumed, while generation early-lock/outbox enrollment across original writers remains distinct and unimplemented here. Authenticated host positivePG/drift/use-fence, runtimeDocumentEpoch and actual lease consumption remain unaccepted. FullGraph projection, whole frontendtypes, HTTP/session/UX and CI/native gates remain open.

Current WritingAid persistence1f03355 was confirmed by its original owner and inspected; existing wiref1cef71 is retained in frozen original root branch. Unique endpoint worker owns newhandler/testpaths; sole handler8208d5d has now been fetched and inspected. Root will inspect the minimal existing route/DI/registry/frames272–274 composition separately, without consuming conflicting whole ancestry. No secondstore, device/header/fingerprint/sessionhash fallback or duplicate handler is introduced.

Parent is sole GitHub PR/content API writer. Proposed draftPR text is accompanying. No merge, close, auto-merge, deployment, frozen-branch edit or deniedCI/workspace-race retry occurred.

## Current consumer membership closure

The former sole3657 supply blocker is nowresolved: exact04ce4b8c60bcfacac02c574690a953a336c69ef3 consumed in source dc9e92882ae452f6b9873c58229f070d96f1da08 afterall4preimages matched. Originalchecker127classes/1073source-estimated cases and11originalNodecontrols pass0skip atdc9; task-onlysourcefixtures cleaned. See artifacts/shared-graph-membership-consumption for exactcommands/roster/cleanup/logs. NoCSharp/native/source logic changed; originalreaderfreshnessP1 remainsopen, and14rootbackend controls stayUNRUN aftertheexistingfailedstrictgate. Priorfailedmembershipandconflictrecords remainhistoricalbindings, notcurrentmissing-supply claims.
