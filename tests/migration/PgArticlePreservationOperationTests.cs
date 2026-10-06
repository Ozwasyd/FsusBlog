using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Pure production-boundary controls. These do not run PostgreSQL, create an owned
// target, publish media, or prove that a complete native migration was registered.
public sealed class PgArticlePreservationOperationTests
{
    [Theory]
    [InlineData("operator-owned-run")]
    [InlineData("opaque:attempt/one")]
    [InlineData("not-a-guid")]
    public void HostInvocationRemainsOpaqueAndIsNotConvertedToAMediaGuid(string invocation)
        => PgArticlePreservationOperation.RequireInvocation(invocation);

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(" leading")]
    [InlineData("trailing ")]
    [InlineData("line\nbreak")]
    public void InvalidHostInvocationIsRejectedByTheSameProductionBoundary(string invocation)
        => Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireInvocation(invocation));

    [Fact]
    public void HostInvocationLengthUsesTheOriginal160CharacterLimit()
    {
        PgArticlePreservationOperation.RequireInvocation(new string('a', 160));
        Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireInvocation(new string('a', 161)));
    }

    [Fact]
    public void ExplicitFiniteConfigurationKeepsAnIndependentMediaRunId()
        => PgArticlePreservationOperation.RequireConfiguration(Configuration());

    [Theory]
    [InlineData("run")]
    [InlineData("source-relative")]
    [InlineData("target-relative")]
    [InlineData("read-budget")]
    [InlineData("unbounded-read-budget")]
    [InlineData("generation-traversal")]
    [InlineData("userinfo")]
    [InlineData("projection-budget")]
    public void MissingOrUnsafeNativeInputsAreRefusedBeforeSourceOrTargetEffects(string missing)
    {
        PgArticlePreservationMediaConfiguration valid = Configuration();
        PgArticlePreservationMediaConfiguration invalid = missing switch
        {
            "run" => valid with { MediaRunId = Guid.Empty },
            "source-relative" => valid with { SourceAssetRoot = "uploads" },
            "target-relative" => valid with { TargetParent = "assets" },
            "read-budget" => valid with { SourceReadBudget = TimeSpan.Zero },
            "unbounded-read-budget" => valid with { SourceReadBudget = TimeSpan.MaxValue },
            "generation-traversal" => valid with { TargetDirectoryName = "../generation" },
            "userinfo" => valid with { TrustedSiteOrigin = new Uri("https://name@example.test/") },
            "projection-budget" => valid with { ProjectionLimits = valid.ProjectionLimits with { MaximumArticles = 0 } },
            _ => throw new ArgumentOutOfRangeException(nameof(missing))
        };
        if (missing == "generation-traversal")
            Assert.Throws<ArticleMediaException>(() => PgArticlePreservationOperation.RequireConfiguration(invalid));
        else
            Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireConfiguration(invalid));
    }

    private static PgArticlePreservationMediaConfiguration Configuration()
        => new(Guid.Parse("d3030289-c3c5-49a4-b7d8-73dca9a4620f"), "/source/uploads",
            new Uri("https://example.test/"), "/uploads/", "/target/assets", "article-generation",
            new(100, 100, 1_000_000), new(100, 100, 100, 100_000, 4096, 1_000_000, 1_000_000, 10_000_000),
            new(100, 10, 100, 1_000_000, TimeSpan.FromSeconds(1)), TimeSpan.FromSeconds(1));

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OriginalBodyFailureSurvivesASecondaryResourceDisposalFailure(bool cancelled)
    {
        Exception primary = cancelled ? new OperationCanceledException() : new InvalidOperationException("original-body");
        var resource = new FailingResource();
        Exception observed = await Assert.ThrowsAnyAsync<Exception>(() => PgArticlePreservationOperation.PreserveFirstAsync<int>(
            resource, () => Task.FromException<int>(primary)));
        Assert.Same(primary, observed);
        Assert.True(resource.DisposeObserved);
        Assert.Equal("article_preservation_operation_resource_disposal_failed",
            observed.Data["FsusBlog.ArticlePreservation.OperationCleanupFailure"]);
    }

    [Fact]
    public async Task ADisposalFailureAloneDoesNotReturnSuccessfulArtifactEvidence()
    {
        var resource = new FailingResource();
        Exception observed = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgArticlePreservationOperation.PreserveFirstAsync(resource, () => Task.FromResult(42)));
        Assert.Same(resource.Failure, observed);
        Assert.True(resource.DisposeObserved);
    }

    private sealed class FailingResource : IAsyncDisposable
    {
        internal Exception Failure { get; } = new InvalidOperationException("resource-dispose");
        internal bool DisposeObserved { get; private set; }
        public ValueTask DisposeAsync()
        {
            DisposeObserved = true;
            return ValueTask.FromException(Failure);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FullAcceptedMediaJournalSelectsOriginalPreparedOrCommittedTargetRecovery(bool committed)
    {
        // Integrity/phase control only: fixture owners cannot observe or execute a database.
        OfflineMigrationPlan plan = JournalPlan();
        var artifact = new CurrentSchemaArtifactReference("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
        var progress = new OfflineMigrationApplyJournalVerifier(plan, artifact, "opaque-invocation");
        progress.BindOperationOwners(new JournalFixtureRegistry());
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationProviderOperation identity = step.Operations[0];
        OfflineMigrationPredicateObservation Observation(string predicate)
        {
            var value = new OfflineMigrationPredicateObservation(predicate, identity.OperationReference,
                identity.OperationSourceDigest, identity.SemanticDigest, [new("rows", "2")], [new("rows", "2")], "");
            return value with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(value) };
        }
        OfflineMigrationApplyJournalEntry Control(OfflineMigrationApplyJournalState state)
            => new(OfflineMigrationApplyJournalVerifier.Format, artifact, plan.ContentDigest, plan.Source.Database,
                "opaque-invocation", (progress.Last?.Sequence ?? 0) + 1, 1, null, null, null, state,
                null, null, null, null, 0, 0, false, null, null,
                progress.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest, "", null,
                new DateTimeOffset(2026, 10, 3, 0, 0, 0, TimeSpan.Zero));
        void Accept(OfflineMigrationApplyJournalEntry value)
            => progress.Accept(value with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(value) });
        Accept(Control(OfflineMigrationApplyJournalState.AttemptStarted));
        var evidence = new OfflineMigrationMediaJournalEvidence("opaque-invocation",
            new(Guid.Parse("8b2b3f9a-91d1-4c77-b478-005a1660e2a4"), artifact.Sha256, plan.ContentDigest,
                plan.Source.ContentDigest, new string('b', 64), "source-root", "target-root", "generation"), null);
        Accept(Control(OfflineMigrationApplyJournalState.MediaPrepared) with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat, StepId = step.StepId,
            OperationReference = identity.OperationReference, Mode = identity.Mode,
            IdempotencyKey = step.IdempotencyDefinition, Before = Observation(step.SourcePrecondition), Media = evidence
        });
        Assert.False(PgArticlePreservationOperation.RequiresCommittedTarget(progress, step.StepId, identity));
        if (committed)
        {
            evidence = evidence with { GenerationIdentity = "actual-fixture-generation" };
            Accept(Control(OfflineMigrationApplyJournalState.MediaPublished) with
            {
                Format = OfflineMigrationApplyJournalVerifier.MediaFormat, StepId = step.StepId,
                OperationReference = identity.OperationReference, Mode = identity.Mode,
                IdempotencyKey = step.IdempotencyDefinition, Before = Observation(step.SourcePrecondition), Media = evidence
            });
            Accept(Control(OfflineMigrationApplyJournalState.TransactionCommitted) with
            {
                Format = OfflineMigrationApplyJournalVerifier.MediaFormat, StepId = step.StepId,
                OperationReference = identity.OperationReference, Mode = identity.Mode,
                IdempotencyKey = step.IdempotencyDefinition, RowsProcessed = 2, ExpectedRows = 2, UnitComplete = true,
                Before = Observation(step.SourcePrecondition), After = Observation(step.TargetPostcondition), Media = evidence
            });
        }
        Assert.Equal(committed, PgArticlePreservationOperation.RequiresCommittedTarget(progress.Fork(), step.StepId, identity));
        Assert.Equal(1, progress.First!.Sequence);
    }

    [Theory]
    [InlineData("unknown-table")]
    [InlineData("partial-schema")]
    [InlineData("unsupported-object")]
    public void ApplySourceUsesTheOriginalUnknownAndPartialSchemaRefusalPredicate(string drift)
    {
        ImmutableArray<OfflineMigrationFact> original = OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.True(OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.PostgreSql, original));
        ImmutableArray<OfflineMigrationFact> changed = drift switch
        {
            "unknown-table" => [.. original, new("table/unknown", "base")],
            "partial-schema" => original.RemoveAt(original.Length - 1),
            "unsupported-object" => original.Select(fact => fact.Name == "objects.unsupported" ? fact with { Value = "1" } : fact).ToImmutableArray(),
            _ => throw new ArgumentOutOfRangeException(nameof(drift))
        };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.PostgreSql, changed));
    }

    private static OfflineMigrationPlan JournalPlan()
    {
        string digest = new('a', 64);
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "fixture-instance", "fixture-database");
        var source = new OfflineMigrationSourceObservation(database, "fixture-extractor", "v1", [], [], [], digest);
        var reference = new CurrentSchemaArtifactReference("fixture-backup", digest);
        var time = new DateTimeOffset(2026, 10, 3, 0, 0, 0, TimeSpan.Zero);
        var backup = new OfflineMigrationBackupObservation(reference, reference, reference, "fixture-owner", "v1",
            time, time, "fixture-snapshot", digest, digest, source, source, []);
        var identity = new OfflineMigrationProviderOperation(CurrentSchemaProviderKind.PostgreSql, "fixture-compiled-owner", digest, digest,
            OfflineMigrationExecutionMode.Transaction);
        var step = new OfflineMigrationStep(PgArticlePreservationOperation.StepReference,
            PgArticlePreservationOperation.SourcePredicate, PgArticlePreservationOperation.TargetPredicate, [],
            "fixture-idempotency", true, new("fixture-resume", 0, "no-watermark", PgArticlePreservationOperation.TargetPredicate), [identity]);
        var plan = new OfflineMigrationPlan("fixture-plan-integrity-only", source, "fixture-profile", "v1", digest,
            new("v1", "v1", "v1", digest, digest), "fixture-dag", "v1", digest, [step], backup,
            new(new string('a', 40), digest, digest, digest), "");
        return plan with { ContentDigest = OfflineMigrationPlanCodec.ComputeContentDigest(plan) };
    }

    private sealed class JournalFixtureRegistry : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
            => new JournalFixtureOperation(identity);
    }

    private sealed class JournalFixtureOperation(OfflineMigrationProviderOperation identity) : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicate,
            DbConnection connection, DbTransaction transaction, CancellationToken token)
            => throw new NotSupportedException("phase_fixture_has_no_native_observation");
        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocation, DbConnection connection, DbTransaction transaction, CancellationToken token)
            => throw new NotSupportedException("phase_fixture_has_no_native_source_or_media");
        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previous, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken token)
            => throw new NotSupportedException("phase_fixture_has_no_native_execution");
    }
}
