# Complete repaired enrollment closure for the original Vault consumer

Current source return: `2028188e5868c414894815ffefcb0d8ab2e78a5b`.
Prior complete 27-path source and build/admission evidence: `b4f0e8f5019253e5e937d4b07d6231f3a1b22d80`.
Exact consumer baseline: `abb28c41213f6ea506a6b4dcb64f30b7451384b7`.
Original consumer implementation: `08dbbac2bb522ca7f6b2433c02acbb60490149f0`.
Published branch: `task/3654-vault-enrollment-compatibility`.
Same independent reviewer: `01a120b7-c3a0` through the coordinator.
Runtime qualification: withheld. All 15 issue acceptances remain OPEN.

## Minimal complete source sequence

Apply these three exact increments against their checked preimages; intervening
handoff-only commits need not be imported:

1. `aa193c2dbc27389e9684642a193de934ec62a9c6`, directly based on abb28:
   the original complete 22-path generation/writer/fixture compatibility closure.
2. `4883b1985929e9aa1f2a63df8307fa5305c90849`: the one-file original stale-revision
   no-write correction. Its test preimage is byte-identical to aa193, although its
   actual parent is handoff commit `0e9dffa95be042e0dd05da4529aedd2380427ede`.
3. `b4f0e8f5019253e5e937d4b07d6231f3a1b22d80`: exact consumption of canonical3657
   supplier `59ecb523309b57ea674234832091aeccc14135c5`, itself directly based on aa193.
   All five original metadata/control preimages matched, apply-check exited 0,
   and every resulting file is byte-identical to the supplied candidate.

`source-closure.json` gives all 27 exact consumer-preimage and resulting Git blobs.
Do not apply only the last five callbacks, transplant b98 counts or import inherited
mother history. Any later consumer-preimage drift returns to the canonical owners.
Frozen b98 and aa193 remain unchanged. The rejected b98-specific bb2a1dc registration
was never applied; its actual-graph discrepancy and the correct resolution remain
in `registration-discrepancy.json`.

## Preserved boundaries and repaired original controls

The generation closure keeps authenticated transport, typed SiteIdentity,
HttpContext mapping, permission and unrelated registration work intact. The
consumer Markdown admission/normalizer is preserved; only generation transaction,
outbox and cancellation hunks change its lifecycle writer. Consumer
ArticleRevisionPersistence, CanonicalUrl DTO and authoring projection stay
byte-identical. Two exact original coordinate definitions required by the unchanged
six-case control are carried; no coordinate authority implementation or revision
writer hook is imported.

Every original outer native transaction acquires the family lock before its existing
identity/advisory/article locks. Inner create/lifecycle and Vault group flows require
the already-held native lock. Each original inserted outbox EventId enrolls in the
same original client and transaction before commit. Production scopes restore caller
ADO cancellation without disposing caller CTS or changing transaction lifetime.
No fabricated event, identity store, runtime DDL or production migration is added.

The three original fixture files use their existing disposable CodeFirst helper and
original coordinate schema definition. ArticleCreate provisions all three source
entities and rights/responsibility/publication tables parsed by native enrollment.
Canonical publication and lifecycle fixtures provision the source entities and
original disposable coordinate schema. Original methods, request fields and all
assertion values are preserved; automatic enrollment remains mandatory.

The same reviewer found that aa193's stale-revision counts after rollback could
mask writes before a conflict. The separately identifiable 4883b198 correction moves
the original conflict assertion and three original counts into the SAME caller
transaction BEFORE finally rollback. Incorrect writes remain observable; assertion
or unexpected-exception failures still execute unconditional cleanup. This source
fix is not represented as dynamically reproduced or runtime verified.

## Current bounded verification

All results below bind to current source b4f0e8f50:

- Original PostgreSQL collection checker exits 0: 128 classes, 999 source-estimated
  cases, A451/B548. These are source estimates, not executed database case counts.
- Eleven allowed original Node controls pass, zero failures and zero skips.
- Original Release project build exits 0: 1,507 retained warnings, zero errors.
- Incremental registration change-contract and diff checks exit 0.
- Actual original matrix preflight exits 1. Rejection messages match the actual
  abb28 baseline apart from the Node PID. It rejects release-final Node parser
  identity, execution declaration/target-path indices, finite targets and
  owner/content/dependency closure. Collection registration does not bypass it.

Commands:

```sh
node tools/check-postgres-test-collections.mjs
node --test tests/tools/check-postgres-test-collections.test.mjs
/workspace/.setup/dotnet/dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore --configuration Release --disable-build-servers -p:UseSharedCompilation=false -v minimal
node tools/run-test-matrix.mjs preflight
node tools/governance/check-change-contract.mjs --range 069b7f8b5ed9369add23b78ae7f507e424a40915..b4f0e8f5019253e5e937d4b07d6231f3a1b22d80
git diff --check 069b7f8b5ed9369add23b78ae7f507e424a40915..b4f0e8f5019253e5e937d4b07d6231f3a1b22d80
```

Locked restore previously exited 0 at aa193; project and lock inputs are unchanged.
Earlier builds and preflight/collection failures remain bound to their respective
sources and are preserved task-locally. Raw logs, sensitive metadata and credentials
are not published to finish this handoff. No broad or held audit ran.

## Remaining gate and exact next selection

Current full original admission must genuinely pass after the canonical authority
owner supplies its corrections. No authority snapshots, finite target scope,
negative controls or qualification gates are weakened here. After admission, the
pending list in source-closure.json contains thirteen precise ordinary methods:
six enrollment controls, six original ArticleCreate controls and the original
stale-revision no-write control. None has executed at this repaired consumer source.
No container or database runtime has started for this current admission run.

Full Vault/group, scheduler batch, canonical publication/lifecycle receipts,
public/HTTP/current-publication/persisted-command/AOT readback, current schema and
whole native/style/frontend qualification remain withheld. Frozen b98's previous
six PostgreSQL executions (6 passed, 0 failed, 0 skipped, nine lifecycle events and
confirmed cleanup) remain executed-but-unqualified and are not current-source
passes. Earlier compile/cancellation failures and subsequent real repairs remain
preserved. No retroactive qualification, PR/body/comment/label/ready/merge/deploy
write or issue closure is performed.

Return this complete 27-path source, original before-rollback negative control,
exact registration and actual current admission blocker to the SAME reviewer.

## Portable retained admission failure routing

`admission-owner-routing.json` exports every one of the seven actual preflight
rejections at b4f0e8f50 with exact messages, paths, expected/actual digests, original
source decisions and canonical owner routing. The recorded command was
`node tools/run-test-matrix.mjs preflight`, from 2026-10-09T13:51:51.063547Z through
2026-10-09T13:54:53.648077Z, exit 1. No preflight, test or runtime identity probe was
rerun for this export. PID, raw logs and sensitive output are not published.

The matrix names ServerContractAgent for all three rejected diagnostic tier owners
and validate-matrix; the coordinator must map this existing role to its original
root tasks. The unchanged execution-authority producer cannot repair a mismatched
independent source index by itself: it checks parser, declaration and path identity
and refuses before writing. Preserve those original admission requirements.

Index and fixture agree on the expected Node v24.16.0 / Acorn8.16.0 / Amaro1.1.9
composite, including both builtin-source hashes. The actual run used the original
Node-builtin resolution, not an npm parser. However, retained records omit actual
Node version, executable and actual parser digests; the logged composite mismatch
is real, but its individual differing field cannot be recovered from those records.
Do not claim official runtime identity match from a version string or substitute a
new current-runtime probe for that run's missing identity.

The abbreviated known c46 commit does not resolve from retained local objects; no
exact reviewed c46 path/blob identity was supplied. The current matrix, bundles and
original authority contracts are byte-identical to abb28, and their exact blobs are
listed. This establishes unchanged consumer source, not c46 equality or absence.
The smallest next handoff is the exact c46 full SHA and reviewed matrix/bundle blob
roster, plus canonical toolchain/authority owner evidence for actual parser identity.
All thirteen database controls remain UNRUN and all chain acceptances remain OPEN.


## Original lifecycle fixture header correction

Source commit `2028188e5868c414894815ffefcb0d8ab2e78a5b`, based on
`3d5c7987a52d527c0a34fcb423695fc5fba25621`, moves only the existing
`FsusBlog.Migration.Definitions` using after the Contracts/Core imports in
`CanonicalArticleLifecycleFixturePortIntegrationTests.cs`. The unchanged official
CSharp formatter produced this change. All ordinary using directives and every
byte from namespace onward remain unchanged. Existing requests and assertions
remain exact. This one-file source increment follows the three source increments
above; no inherited history or new implementation is required.

Two actual passes of the command below exit 0: the first corrects one file, the
second corrects zero files.

```sh
node tools/dotnet/check-csharp-style.mjs --fix --mode changed --file tests/backend/Integration/CanonicalArticleLifecycleFixturePortIntegrationTests.cs
```

Both original scoped whitespace/style checks pass; both file-tree digests are
`9b399561b4b7c491144c852052101443f176d5af918ecb7739175e808c8b508b`.
Separate commit `efa320062d622a5d45f64b5762da9846c7655b06` records genuine
idempotence evidence and registers the source commit in `.git-blame-ignore-revs`.

The original incremental format-history gate at efa320062 exits 1:

```text
[change-contract] 2028188e5868c414894815ffefcb0d8ab2e78a5b: Format-only diff changes non-whitespace or quoted-value tokens: tests/backend/Integration/CanonicalArticleLifecycleFixturePortIntegrationTests.cs
```

This is a retained qualification failure, separate from the two scoped style
passes. No current checker, policy, equivalence rule or baseline changed, and no
unpromoted using-equivalence proposal was consumed. The gate argv, exact tested
HEAD, times, exit code and message are in `lifecycle-using-order-handoff.json` and
`artifacts/style/chain-3654-lifecycle-using-order-idempotence.json`.

No DB control, build, preflight, SDK probe or broader test reran for this header
correction. Prior build/admission receipts remain bound to b4f0e8f50, and thirteen
DB controls remain UNRUN. Return this exact mechanical source plus the genuine
failed qualification record to the same reviewer through the coordinator; all
fifteen issue acceptances remain OPEN.
