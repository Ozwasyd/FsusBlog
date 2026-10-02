using System.Collections.Immutable;
using System.Data.Common;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Actual issuer binding and original journal predicates; synthetic observations
// cannot qualify native media execution or create either producer capability.
public sealed class OfflineMigrationCurrentSchemaMediaBindingTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly DateTimeOffset s_time = new(2026, 10, 3, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void IndependentIssuerBindsActualMediaOwnerBeforeFirstNativeEntry()
    {
        OfflineMigrationPlan plan = Plan();
        var registry = new MediaRegistry();
        OfflineMigrationApplyJournalVerifier journal = OfflineMigrationCurrentSchemaIssuer.CreateBoundJournalVerifier(
            plan, Artifact(plan), "invocation", registry);
        Assert.Equal(3, registry.Resolved);
        Accept(journal, Control(plan, journal, OfflineMigrationApplyJournalState.AttemptStarted));
        OfflineMigrationApplyJournalEntry prepared = Prepared(plan, journal);
        Accept(journal, prepared);
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPrepared, journal.PendingMedia!.State);
        Assert.True(journal.RequiresMedia(plan.OrderedSteps[0].StepId));
        Assert.Equal(0, registry.NativeCalls);

        // The old unbound issuer path really rejects these same valid v2 bytes.
        var unbound = new OfflineMigrationApplyJournalVerifier(plan, Artifact(plan), "invocation");
        Accept(unbound, Control(plan, unbound, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Equal("offline_apply_media_owner_missing", Assert.Throws<InvalidOperationException>(() =>
            Accept(unbound, Prepared(plan, unbound))).Message);
    }

    [Fact]
    public void ChangedActualIdentityCannotReturnABoundIndependentVerifier()
    {
        OfflineMigrationPlan plan = Plan();
        var registry = new MediaRegistry { Changed = true };
        Assert.Equal("offline_apply_operation_binding_changed", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.CreateBoundJournalVerifier(plan, Artifact(plan), "invocation", registry)).Message);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void MissingActualOwnerPreservesItsRefusalBeforeAnyEntryOrNativeWork()
    {
        OfflineMigrationPlan plan = Plan();
        var registry = new MediaRegistry { Missing = true };
        Assert.Equal("fixture_compiled_owner_missing", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCurrentSchemaIssuer.CreateBoundJournalVerifier(plan, Artifact(plan), "invocation", registry)).Message);
        Assert.Equal(0, registry.NativeCalls);
    }

    private static OfflineMigrationPlan Plan()
    {
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "instance", "database");
        var source = new OfflineMigrationSourceObservation(database, "extractor", "v1", [], [], [], s_digest);
        var artifact = new CurrentSchemaArtifactReference("fixture-backup", s_digest);
        var backup = new OfflineMigrationBackupObservation(artifact, artifact, artifact, "fixture-owner", "v1",
            s_time, s_time, "fixture-snapshot", s_digest, s_digest, source,
            source with { Database = database with { DatabaseId = "restored" } },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, s_digest)).ToImmutableArray());
        var step = new OfflineMigrationStep("owned-step", "owned-source", "owned-target", [], "owned-idempotency", false,
            new("v1", 0, "owned-watermark", "owned-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "fixture-operation", s_digest, s_digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1", [new("fixture-profile", "v1", "fixture-owner",
            [nameof(IndependentIssuerBindsActualMediaOwnerBeforeFirstNativeEntry)], step.StepId,
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(
                provider, source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        return OfflineMigrationPlanBuilder.Create(source, backup, new("v1", "v1", "v1", s_digest, s_digest),
            new(new('a', 40), s_digest, s_digest, s_digest), registry, new("fixture-dag", "v1", [step]),
            s_time, TimeSpan.FromHours(1));
    }

    private static CurrentSchemaArtifactReference Artifact(OfflineMigrationPlan plan)
        => new("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));

    private static OfflineMigrationApplyJournalEntry Control(OfflineMigrationPlan plan,
        OfflineMigrationApplyJournalVerifier journal, OfflineMigrationApplyJournalState state)
        => new(OfflineMigrationApplyJournalVerifier.Format, Artifact(plan), plan.ContentDigest, plan.Source.Database,
            "invocation", (journal.Last?.Sequence ?? 0) + 1, 1, null, null, null, state, null, null, null, null,
            0, 0, false, null, null, journal.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
            string.Empty, null, s_time);

    private static OfflineMigrationApplyJournalEntry Prepared(OfflineMigrationPlan plan,
        OfflineMigrationApplyJournalVerifier journal)
    {
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationProviderOperation operation = step.Operations[0];
        var before = new OfflineMigrationPredicateObservation(step.SourcePrecondition, operation.OperationReference,
            operation.OperationSourceDigest, operation.SemanticDigest, [new("rows", "2")], [new("rows", "2")], string.Empty);
        before = before with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(before) };
        return Control(plan, journal, OfflineMigrationApplyJournalState.MediaPrepared) with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
            StepId = step.StepId, OperationReference = operation.OperationReference, Mode = operation.Mode,
            IdempotencyKey = step.IdempotencyDefinition, Before = before,
            Media = new("invocation", new(Guid.Parse("22222222-2222-2222-2222-222222222222"), Artifact(plan).Sha256,
                plan.ContentDigest, plan.Source.ContentDigest, new('b', 64), "actual-source-root", "actual-target-root", "generation"), null)
        };
    }

    private static void Accept(OfflineMigrationApplyJournalVerifier journal, OfflineMigrationApplyJournalEntry entry)
        => journal.Accept(entry with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry) });

    private sealed class MediaRegistry : IOfflineMigrationApplyOperationRegistry
    {
        internal bool Changed { get; init; }
        internal bool Missing { get; init; }
        internal int Resolved { get; private set; }
        internal int NativeCalls { get; set; }

        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
        {
            Resolved++;
            if (Missing) throw new InvalidOperationException("fixture_compiled_owner_missing");
            return new MediaOperation(this, Changed ? identity with { OperationSourceDigest = new('b', 64) } : identity);
        }
    }

    private sealed class MediaOperation(MediaRegistry owner, OfflineMigrationProviderOperation identity)
        : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicate,
            DbConnection connection, DbTransaction transaction, CancellationToken token)
        {
            owner.NativeCalls++;
            throw new NotSupportedException("fixture_native_work_forbidden");
        }
        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocation, DbConnection connection,
            DbTransaction transaction, CancellationToken token)
        {
            owner.NativeCalls++;
            throw new NotSupportedException("fixture_native_work_forbidden");
        }
        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previous, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken token)
        {
            owner.NativeCalls++;
            throw new NotSupportedException("fixture_native_work_forbidden");
        }
    }
}
