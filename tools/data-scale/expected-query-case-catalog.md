# Native query producer intake

This source closure provides test/evidence-only consumers of the original article
and comment producer types. Its four source files are
[the role intake](query-producer-role-intake/QueryProducerRoleIntake.cs),
[the PostgreSQL intake](query-producer-role-intake/QueryPostgresProducerIntake.cs),
[the refusal controls](query-producer-role-intake/QueryProducerRoleIntakeControls.cs)
and [the exact-source harness](query-producer-role-intake/check.sh).
Catalog validation, expected generation and query execution remain with their
canonical owners; those implementations are outside this closure.

## Exact source dependencies

The harness archives the complete original writer backend at
`21a20129b3127fdcfb6f34bff7f80b1ef8b5f239` and overlays nine original comment
source files from `8822207ec995f4346eed20f27393b172dd51343a`:

- `src/backend/Services/Fixtures/DataScale/CanonicalCommentGraphFactory.cs`
- `src/backend/Services/Fixtures/DataScale/CanonicalCommentGraphModels.cs`
- `src/backend/Services/Fixtures/DataScale/CanonicalCommentGraphResolution.cs`
- `src/backend/Services/Fixtures/DataScale/CommentScalePlan.cs`
- `src/backend/Services/Fixtures/DataScale/CommentScalePolicyResolver.cs`
- `src/backend/Services/ArticleCommentPolicyService.cs`
- `src/backend/Services/CommentModerationService.cs`
- `src/backend/Services/CommentService.cs`
- `src/backend/Services/Security/AnonymousCommentPolicyService.cs`

This is an explicitly identified composite integration. Both commits must share
the exact article plan blob. The source manifest binds original commits, trees,
blobs and SHA-256 digests, plus all four local source files. The harness verifies
source bytes before and after controls and preserves the first failing stage.
Working-tree producer files and prebuilt assemblies are not consumed.

The harness uses the original backend's existing `FsusBlog.Server.Tests` friend
assembly grant. It changes no production access declaration or security setting.
It performs locked backend restore, checks native dependency lock bytes and
builds a temporary test assembly without publishing client assets. Original
build warnings remain visible; no warning suppression is added.

## Role intake

`QueryProducerRoleIntake.Inspect(articleBindings, commentIntent)` borrows the
original `ArticleScaleGraphIdentityBindings` and
`CommentScaleResolvedGraphIntent`. It compares article plan digest, semantic
article role, native reference schema/digest and native article coordinate.
It retains original typed objects and inspects one occurrence.

The original comment intent contains symbolic parent/reply requests and planned
moderation. Actual comment IDs and final thread/status/visibility coordinates
still require the comment owner. Matching source references or an empty comment
occurrence cannot establish physical query admission.

## PostgreSQL intake

`QueryPostgresProducerIntake.Inspect` requires the actual same-task producer
result, canonical plan, resolved graph batch, open Npgsql connection,
independently supplied current checkpoint identity and authentic task key.
`ProduceAsync`, resolved-input validation, native allocation, checkpoint
persistence/HMAC validation and publication binding exist in the original source.
The producer result does not retain the optional resolved batch; its caller must
retain the actual input and hand it off with the result.

The intake verifies bounded batch ordinals, whole-plan coverage's plan binding,
native allocation role/ID maps, original alias groups and graph digests.
`CanonicalArticleGraphFactory.DescribeNativeRoles` remains the sole role roster.
Resealing uses its native-binding/resolved-input overload. Bounds remain at
1–1000 graphs, 1–32 allocation observations and at most 50,000 role IDs.

The original authority observes current database identity. Its frozen batch's
original v2 `ExpectedDigest` must match authenticated `PhysicalDigest`; the
original digest covers composite primary keys, complete owned row scopes and
external taxonomy references. Original checkpoint validation requires the exact
current identity and committed stage. Authentication failures propagate without
retry or normalization. The consumer executes no SQL and retains no task key.

Taxonomy projection and readback are implemented: the original projection adds
ArticleTag links to the physical batch, and the original writer persists and
verifies them. `DataScalePublicationRequestBinding.BindAsync` likewise exists;
its actual publication result and current invocation must come from the original
publication owner. No product schema migration is required by this intake.

## Admission and qualification

A genuine small task-local positive can establish component linkage through
`ComponentBindingsMatched`. Its inputs must come from the current original-owner
run, including actual resolved values, independently checked identity,
authenticated committed checkpoint and allocation persistence evidence.
Diagnostic factory defaults, another run's data and reconstructed receipts cannot
supply that evidence. A saved PostgreSQL service alone does not supply the tuple.
The ordinary nonempty path remains unrun in this closure.

Even matched components preserve five unresolved admission boundaries:

- Durable native-allocation persistence receipt intake.
- Query business epoch, fixture generation and seed receipt binding.
- Whole-plan physical materialization receipt.
- Signed audit and complete seed acceptance.
- Actual publication result and current invocation.

Whole-plan assignment coverage does not prove whole-plan physical materialization.
The current checkpoint record lacks query epoch, fixture generation, seed receipt
and assignment coverage digest. The allocation persistence callback is real and
awaited, but returns no typed durable admission receipt. Original
`CompleteSeedAccepted` remains false.

Both inspections keep `CanExecuteQueries`, `Qualification` and
`ReleaseEvidenceEligible` false. `ThrowBeforeQueryExecution()` refuses even if a
caller empties its diagnostic blockers or sets component matching true. The
original query runner owner must integrate admission before expected mapping and
query capture; this source closure does not edit that runner.

## Ordinary refusal controls

Inspect the harness's explicit input requirements:

```sh
bash tools/data-scale/query-producer-role-intake/check.sh --help
```

Run it with `--article-source-root` and `--comment-source-root` naming absolute
Git worktree roots containing the pinned commits, and `--evidence-directory`
naming a new absolute task-owned directory. Existing evidence is never replaced.
The configured saved environment supplies the SDK and locked dependency cache;
other environments must provide the required SDK and dependencies.

The six compiled controls cover null-input blocker preservation, refusal before
subsequent statements and manual-empty blocker refusal for both inspections.
They construct no producer objects, native IDs, keys, expected values or receipts.
The manifest and logs establish exact-source compilation and refusal behavior.
They do not establish nonempty PostgreSQL matching, physical acceptance, query
coverage, browser/device behavior, scale performance or release qualification.
