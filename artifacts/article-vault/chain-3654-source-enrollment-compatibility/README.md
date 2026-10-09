# Bounded source-generation closure for the original Vault consumer

Source candidate: `aa193c2dbc27389e9684642a193de934ec62a9c6`.
Exact parent/consumer baseline: `abb28c41213f6ea506a6b4dcb64f30b7451384b7`.
Original consumer implementation: `08dbbac2bb522ca7f6b2433c02acbb60490149f0`.
Published branch: `task/3654-vault-enrollment-compatibility`.
Frozen independent-review supplier: `b98e179b0c0ac6c1f85790fcce3bd918a3aa6cdc` (unchanged).

## Complete bounded consumption

Consume the one 22-path source commit against its exact parent, rather than the
last five callbacks or the inherited supplier branch. `source-closure.json` gives
all exact preimage and resulting Git blobs, including explicit absent paths.
The original 17-path generation delta passed `git apply --check` on this actual
consumer with zero conflicts; its final-five-only patch had lacked prerequisites.
The five shared ArticleService preimages are byte-identical to the frozen
supplier delta's original preimages. No authenticated transport, typed SiteIdentity,
HttpContext mapping, permission or registration code is replaced.

The bounded closure contains 16 production generation/writer files, the unchanged
six-case enrollment control, two exact original coordinate definitions required
by that control, and three repaired original fixture files. The two coordinate
definitions are byte-identical to `5a0c945d60e75adf5a23e33702718088ed6ac989`:
`src/backend/Entities/ArticleRelationSourceCoordinate.cs` and
`src/migration/Definitions/ArticleRelationSourceCoordinateMigrationDefinitions.cs`.
No coordinate authority implementation or revision-writer hook is imported.
Consumer `ArticleRevisionPersistence.cs`, CanonicalUrl DTO and authoring projection
remain byte-identical to the actual consumer. The consumer's existing Markdown
normalizer/admission in `ArticleLifecycleTransitionWriter.cs` is preserved;
only generation/transaction/outbox/cancellation hunks change there.

Every canonical writer's outer native transaction acquires the source family lock
before its existing identity/advisory/article locks. Inner create/lifecycle and
Vault group flows require the original already-held native lock. Each original
inserted outbox EventId is enrolled using the same original client and transaction,
before commit. Caller ADO cancellation is restored by production scopes; caller
CTS and transaction lifetimes are retained. No event is invented to count a write.
No runtime DDL, new identity store, production migration or general coordinate
semantics change is introduced.

## Original fixture repair

- `ArticleCreateIntegrationTests.cs`: provision all three original source-table
  entity definitions and the rights/responsibility/publication relations parsed
  by the mandatory native enrollment query. Existing CodeFirst test helper and
  original coordinate migration definition run only against disposable fixtures.
- `CanonicalArticlePublicationFixturePortIntegrationTests.cs`: provision the same
  three source entities and original disposable coordinate schema.
- `CanonicalArticleLifecycleFixturePortIntegrationTests.cs`: same provisioning;
  direct stale-revision control now opens its caller native transaction, acquires
  the family lock first and rolls back in `finally`. All original assertions and
  stale-request values remain. No automatic enrollment or negative gate is disabled.

## Verification and remaining admission

Original locked restore and Release build were run on the exact source candidate.
Restore exits 0; build exits 0 with 1,507 retained warnings and zero errors.
Incremental change-contract and `git diff --check` both exit 0. Compilation does
not establish execution qualification. Raw logs remain task-local; they are not
published here and no secrets or runtime credentials are included in this handoff.

Commands:

```sh
/workspace/.setup/dotnet/dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode -p:NuGetAuditMode=all -p:NuGetAuditLevel=low
/workspace/.setup/dotnet/dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore --configuration Release --disable-build-servers -p:UseSharedCompilation=false -v minimal
node tools/governance/check-change-contract.mjs --range abb28c41213f6ea506a6b4dcb64f30b7451384b7..aa193c2dbc27389e9684642a193de934ec62a9c6
git diff --check abb28c41213f6ea506a6b4dcb64f30b7451384b7..aa193c2dbc27389e9684642a193de934ec62a9c6
node tools/run-test-matrix.mjs preflight
node tools/check-postgres-test-collections.mjs
```

Original candidate and exact consumer-baseline preflight each exit 1; their rejection
messages are identical apart from the Node PID. Original preflight is an admission blocker. It rejects release-final static parser
identity, execution declaration/target-path indices, finite execution targets and
owner/content/dependency closure. The exact consumer baseline also fails this
preflight; inherited admission is not repaired by changing its authority snapshots
here. PostgreSQL collection checking rejects the missing new enrollment class and
other inherited registrations/estimated-fact totals. Canonical3657 owns registration;
no manifest is edited in this source increment. Required smallest next input is
its exact registration commit plus original authority-owner corrections and a
really passing original preflight at the resulting current candidate.

No test has executed at this source. After admission, select the six exact methods
in `CanonicalArticleSourceGenerationEnrollmentIntegrationTests` and all six exact
methods in `ArticleCreateIntegrationTests` (12 ordinary methods total). Keep the
original no-write, replay, template/asset, tamper, transaction, missing-lock and
native-cancellation assertions. The remaining full canonical publication/lifecycle
receipt, Vault/group, scheduler and public/HTTP/AOT gates remain withheld; no broad
or held runtime has run. Source-predicted fixture regressions are repaired but are
not represented as dynamically reproduced or runtime verified.

The frozen b98 six PostgreSQL controls were executed previously with 6 passed,
0 failed and 0 skipped, including nine actual lifecycle events and confirmed
container/volume cleanup. They remain executed-but-unqualified, and are not new
passes at this consumer candidate. Earlier compile and cancellation failures remain
preserved in the original handoff. All 15 issue acceptances remain OPEN.

Return this complete closure and its admission blockers to the same independent
reviewer `01a120b7-c3a0` through the coordinator. Independent qualification remains
separate. No PR/body/comment/label/ready/merge/deploy writes or issue closure.
