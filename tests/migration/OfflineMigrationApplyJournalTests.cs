using System.Collections.Immutable;
using System.Data;
using System.Data.Common;

using NSubstitute;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationApplyJournalTests
{
    private static readonly string IdentityDigest = new('a', 64);
    private static readonly DateTimeOffset RecordedAt = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Complete_transaction_chain_requires_committed_unit_then_verified_step()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: true));
        Accept(verifier, Proof(verifier));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted));
        verifier.Complete(Checkpoint(verifier));
        Assert.True(verifier.Completed);
        Assert.Single(verifier.StepProofs);
        Assert.Null(verifier.PendingUnit);
    }

    [Fact]
    public void Staging_fork_does_not_publish_uncommitted_progress()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier original = Verifier(plan);
        Accept(original, Control(plan, original, OfflineMigrationApplyJournalState.AttemptStarted));
        OfflineMigrationApplyJournalVerifier staged = original.Fork();
        Accept(staged, Unit(plan, staged, complete: true));
        Assert.Null(original.PendingUnit);
        Assert.NotNull(staged.PendingUnit);
        Assert.Equal(1, original.Last!.Sequence);
        Assert.Equal(2, staged.Last!.Sequence);
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("parent")]
    [InlineData("sequence")]
    [InlineData("database")]
    [InlineData("invocation")]
    [InlineData("plan")]
    public void Rejects_changed_binding_without_advancing_chain(string changed)
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        OfflineMigrationApplyJournalEntry entry = Seal(Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        entry = changed switch
        {
            "digest" => entry with { ContentDigest = new('b', 64) },
            "parent" => Seal(entry with { PreviousDigest = new('b', 64) }),
            "sequence" => Seal(entry with { Sequence = 2 }),
            "database" => Seal(entry with { Database = entry.Database with { DatabaseId = "other-database" } }),
            "invocation" => Seal(entry with { InvocationId = "other-invocation" }),
            "plan" => Seal(entry with { Plan = entry.Plan with { Reference = "other-plan" } }),
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => verifier.Accept(entry));
        Assert.Null(verifier.Last);
        Assert.False(verifier.Completed);
    }

    [Fact]
    public void Rejects_uncommitted_proof_and_premature_terminal()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            Unit(plan, verifier, complete: true) with { State = OfflineMigrationApplyJournalState.StepVerified }));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted)));
        Assert.Empty(verifier.StepProofs);
    }

    [Fact]
    public void Rejects_failed_actual_predicate_even_with_valid_observation_digest()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        OfflineMigrationApplyJournalEntry unit = Unit(plan, verifier, complete: true);
        OfflineMigrationPredicateObservation failed = unit.After! with { ActualFacts = [new("rows", "999")] };
        failed = failed with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(failed) };
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, unit with { After = failed }));
        Assert.Null(verifier.PendingUnit);
    }

    [Fact]
    public void Batches_preserve_high_watermark_counts_and_exact_resume_boundary()
    {
        OfflineMigrationPlan plan = Plan(OfflineMigrationExecutionMode.CheckpointedBatch);
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: false, rows: 1, watermark: "key-1"));
        OfflineMigrationApplyCheckpoint first = Checkpoint(verifier);
        verifier.Complete(first);
        OfflineMigrationApplyJournalEntry final = Unit(plan, verifier, complete: true, rows: 2, watermark: "key-2");
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, final with { HighWatermark = "changed" }));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, final with { WatermarkBefore = "unknown" }));
        Accept(verifier, final);
        Assert.Throws<InvalidOperationException>(() => verifier.Complete(first));
        Accept(verifier, Proof(verifier));
        Assert.Single(verifier.StepProofs);
        Assert.Equal(2, verifier.StepProofs[0].RowsProcessed);
    }

    [Fact]
    public void Interrupted_attempt_requires_terminal_then_exact_successor_attempt()
    {
        OfflineMigrationPlan plan = Plan(OfflineMigrationExecutionMode.CheckpointedBatch);
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: false, rows: 1, watermark: "key-1"));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted, attempt: 2)));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.RecoveryRequired,
            failure: "offline_apply_prior_attempt_interrupted"));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted, attempt: 2));
        Assert.Equal("key-1", verifier.PendingUnit!.WatermarkAfter);
        Accept(verifier, Unit(plan, verifier, complete: true, rows: 2, watermark: "key-2") with { Attempt = 2 });
        Accept(verifier, Proof(verifier) with { Attempt = 2 });
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted, attempt: 2));
        Assert.True(verifier.Completed);
    }

    [Fact]
    public void Empty_plan_is_never_a_successful_apply_plan()
    {
        OfflineMigrationPlan plan = Plan() with { OrderedSteps = [] };
        plan = plan with { ContentDigest = OfflineMigrationPlanCodec.ComputeContentDigest(plan) };
        Assert.Throws<InvalidOperationException>(() => Verifier(plan));
    }

    [Fact]
    public void Actual_canonical_artifact_sha_is_not_the_payload_semantic_seal()
    {
        OfflineMigrationPlan plan = Plan();
        string actualBytesSha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            OfflineMigrationPlanCodec.Serialize(plan)));
        Assert.NotEqual(plan.ContentDigest, actualBytesSha);
        Assert.Equal(actualBytesSha, Artifact(plan).Sha256);
        Assert.Throws<InvalidOperationException>(() => new OfflineMigrationApplyJournalVerifier(
            plan, Artifact(plan) with { Sha256 = plan.ContentDigest }, "invocation"));
        Assert.Null(Verifier(plan).Last);
    }

    [Fact]
    public void Transaction_mode_cannot_claim_partial_or_batch_commit()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, Unit(plan, verifier, complete: false)));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            Unit(plan, verifier, complete: true) with { State = OfflineMigrationApplyJournalState.BatchCommitted }));
        Assert.Null(verifier.PendingUnit);
    }

    [Fact]
    public async Task Unsupported_native_provider_is_rejected_before_connection_or_admission_use()
    {
        OfflineMigrationPlan plan = Plan(provider: CurrentSchemaProviderKind.MySql);
        DbConnection connection = Substitute.For<DbConnection>();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true),
            connection, admission, registry, CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains("offline_apply_native_provider_not_supported", result.Codes);
        Assert.Null(result.Checkpoint);
        Assert.Empty(result.StepProofs);
        Assert.Empty(connection.ReceivedCalls());
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Fact]
    public async Task Destructive_confirmation_is_rejected_before_lock_or_admission_use()
    {
        OfflineMigrationPlan plan = Plan(destructive: true);
        DbConnection connection = Substitute.For<DbConnection>();
        connection.State.Returns(ConnectionState.Open);
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, false),
            connection, admission, registry, CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains("offline_apply_admission_options_invalid", result.Codes);
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Fact]
    public async Task Missing_compiled_operation_owner_rejects_after_lock_before_any_transaction_or_write()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        Assert.Equal(ConnectionState.Open, connection.State);
        Assert.Equal(plan.ContentDigest, OfflineMigrationPlanCodec.ComputeContentDigest(plan));
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true),
            connection, admission, new MissingOfflineMigrationApplyOperationRegistry(), CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains("offline_apply_rejected", result.Codes);
        Assert.Null(result.Checkpoint);
        Assert.Empty(result.StepProofs);
        Assert.Equal(0, connection.TransactionAttempts);
        Assert.Equal(0, connection.WriteAttempts);
        Assert.Equal(new[] { "SELECT pg_try_advisory_lock(hashtext(@name))", "SELECT pg_advisory_unlock(hashtext(@name))" },
            connection.Commands);
        Assert.Empty(admission.ReceivedCalls());
    }

    [Fact]
    public async Task Already_cancelled_apply_has_no_native_lock_or_write_side_effect()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true),
            connection, admission, registry, cancellation.Token);
        Assert.Equal(OfflineMigrationApplyStatus.Cancelled, result.Status);
        Assert.Contains("offline_apply_cancelled", result.Codes);
        Assert.Empty(connection.Commands);
        Assert.Equal(0, connection.WriteAttempts);
        Assert.Equal(0, connection.TransactionAttempts);
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Fact]
    public async Task Wrong_exact_plan_artifact_rejects_before_native_connection_use()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan) with { Sha256 = new('b', 64) },
            new("invocation", 1, true), connection, admission, registry, CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains("offline_apply_plan_binding_invalid", result.Codes);
        Assert.Empty(connection.Commands);
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Fact]
    public async Task Locked_source_admission_rejection_leaves_control_and_business_state_unwritten()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection(allowReadOnlyAdmission: true);
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        admission.RevalidateAsync(Arg.Any<VerifiedOfflineMigrationPlan>(), Arg.Any<CurrentSchemaArtifactReference>(),
            Arg.Any<OfflineMigrationApplyJournalVerifier>(), Arg.Any<DbConnection>(), Arg.Any<DbTransaction>(),
            Arg.Any<CancellationToken>()).Returns(call =>
            {
                Assert.Same(connection, call.Arg<DbConnection>());
                Assert.Same(connection, call.Arg<DbTransaction>().Connection);
                Assert.Equal(IsolationLevel.RepeatableRead, call.Arg<DbTransaction>().IsolationLevel);
                throw new InvalidOperationException("fixture_source_database_drift_private_detail");
            });
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true),
            connection, admission, new FixtureOperationRegistry(), CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Equal(new[] { "offline_apply_rejected" }, result.Codes);
        Assert.DoesNotContain("fixture_source_database_drift_private_detail", string.Join(';', result.Codes));
        Assert.Null(result.Checkpoint);
        Assert.Empty(result.StepProofs);
        Assert.Equal(1, connection.TransactionAttempts);
        Assert.Equal(1, connection.TransactionDisposals);
        Assert.Equal(0, connection.WriteAttempts);
        Assert.Equal(3, connection.Commands.Count);
    }

    [Fact]
    public async Task In_flight_locked_admission_cancellation_has_no_control_or_business_write()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection(allowReadOnlyAdmission: true);
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        admission.RevalidateAsync(Arg.Any<VerifiedOfflineMigrationPlan>(), Arg.Any<CurrentSchemaArtifactReference>(),
            Arg.Any<OfflineMigrationApplyJournalVerifier>(), Arg.Any<DbConnection>(), Arg.Any<DbTransaction>(),
            Arg.Any<CancellationToken>()).Returns(async call =>
            {
                Assert.Same(connection, call.Arg<DbConnection>());
                Assert.Equal(IsolationLevel.RepeatableRead, call.Arg<DbTransaction>().IsolationLevel);
                entered.TrySetResult();
                await release.Task;
                call.Arg<CancellationToken>().ThrowIfCancellationRequested();
            });
        Task<OfflineMigrationApplyResult> pending = OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true),
            connection, admission, new FixtureOperationRegistry(), cancellation.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(pending.IsCompleted);
            Assert.Equal(0, connection.WriteAttempts);
            cancellation.Cancel();
            release.TrySetResult();
            OfflineMigrationApplyResult result = await pending;
            Assert.Equal(OfflineMigrationApplyStatus.Cancelled, result.Status);
            Assert.Null(result.Checkpoint);
            Assert.Empty(result.StepProofs);
            Assert.Equal(0, connection.WriteAttempts);
            Assert.Equal(1, connection.TransactionDisposals);
            Assert.Equal("SELECT pg_advisory_unlock(hashtext(@name))", connection.Commands[^1]);
        }
        finally
        {
            release.TrySetResult();
            await pending;
        }
    }

    private static OfflineMigrationPlan Plan(OfflineMigrationExecutionMode mode = OfflineMigrationExecutionMode.Transaction,
        CurrentSchemaProviderKind provider = CurrentSchemaProviderKind.PostgreSql, bool destructive = false)
    {
        var database = new CurrentSchemaDatabaseIdentity(provider, "instance", "database");
        var source = new OfflineMigrationSourceObservation(database, "extractor", "v1", [], [], [], IdentityDigest);
        var artifact = new CurrentSchemaArtifactReference("fixture-backup", IdentityDigest);
        var backup = new OfflineMigrationBackupObservation(artifact, artifact, artifact, "fixture-owner", "v1",
            RecordedAt, RecordedAt, "fixture-snapshot", IdentityDigest, IdentityDigest,
            source, source with { Database = database with { DatabaseId = "restored" } },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, IdentityDigest)).ToImmutableArray());
        var step = new OfflineMigrationStep("owned-step", "owned-source", "owned-target", [], "owned-idempotency", destructive,
            new("v1", mode == OfflineMigrationExecutionMode.Transaction ? 0 : 1, "owned-watermark", "owned-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "fixture-operation", IdentityDigest, IdentityDigest, mode)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1",
            [new("fixture-profile", "v1", "fixture-owner", [nameof(Complete_transaction_chain_requires_committed_unit_then_verified_step)],
                step.StepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(value => new OfflineMigrationSourceShape(
                    value, source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        var dag = new OfflineMigrationDag("fixture-dag", "v1", [step]);
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", IdentityDigest, IdentityDigest);
        var tool = new CurrentSchemaVerifierIdentity(new('a', 40), IdentityDigest, IdentityDigest, IdentityDigest);
        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(source, backup, target, tool, registry, dag,
            RecordedAt, TimeSpan.FromHours(1));
        // The normal pure builder/verifier validates this synthetic fixture's closure.
        // None of these fixture observations are a real backup, DB proof, or operation grant.
        return OfflineMigrationPlanVerifier.Verify(plan, source, backup, target, tool, registry, dag,
            RecordedAt, TimeSpan.FromHours(1)).Plan;
    }

    private static CurrentSchemaArtifactReference Artifact(OfflineMigrationPlan plan)
        => new("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
    private static OfflineMigrationApplyJournalVerifier Verifier(OfflineMigrationPlan plan) => new(plan, Artifact(plan), "invocation");
    private static OfflineMigrationApplyCheckpoint Checkpoint(OfflineMigrationApplyJournalVerifier verifier)
        => new(OfflineMigrationApplyJournalVerifier.Reference(verifier.Last!), "invocation", verifier.Last!.Sequence);
    private static OfflineMigrationApplyJournalEntry Seal(OfflineMigrationApplyJournalEntry entry)
        => entry with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry) };
    private static void Accept(OfflineMigrationApplyJournalVerifier verifier, OfflineMigrationApplyJournalEntry entry)
        => verifier.Accept(Seal(entry));
    private static OfflineMigrationApplyJournalEntry Control(OfflineMigrationPlan plan, OfflineMigrationApplyJournalVerifier verifier,
        OfflineMigrationApplyJournalState state, int attempt = 1, string? failure = null)
        => new(OfflineMigrationApplyJournalVerifier.Format, Artifact(plan), plan.ContentDigest, plan.Source.Database, "invocation",
            (verifier.Last?.Sequence ?? 0) + 1, attempt, null, null, null, state, null, null, null, null,
            0, 0, false, null, null, verifier.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
            string.Empty, failure, RecordedAt);
    private static OfflineMigrationPredicateObservation Observation(OfflineMigrationPlan plan, string predicate)
    {
        OfflineMigrationProviderOperation operation = plan.OrderedSteps[0].Operations[0];
        var observation = new OfflineMigrationPredicateObservation(predicate, operation.OperationReference,
            operation.OperationSourceDigest, operation.SemanticDigest, [new("rows", "2")], [new("rows", "2")], string.Empty);
        return observation with { ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation) };
    }

    private static OfflineMigrationApplyJournalEntry Unit(OfflineMigrationPlan plan, OfflineMigrationApplyJournalVerifier verifier,
        bool complete, long rows = 2, string? watermark = null)
    {
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationProviderOperation operation = step.Operations[0];
        return Control(plan, verifier, operation.Mode == OfflineMigrationExecutionMode.Transaction
            ? OfflineMigrationApplyJournalState.TransactionCommitted : OfflineMigrationApplyJournalState.BatchCommitted) with
        {
            StepId = step.StepId, OperationReference = operation.OperationReference, Mode = operation.Mode,
            IdempotencyKey = step.IdempotencyDefinition, RowsProcessed = rows, ExpectedRows = 2, UnitComplete = complete,
            WatermarkBefore = verifier.PendingUnit?.WatermarkAfter, WatermarkAfter = watermark,
            HighWatermark = operation.Mode == OfflineMigrationExecutionMode.CheckpointedBatch ? "key-2" : null,
            Before = Observation(plan, verifier.PendingUnit is null ? step.SourcePrecondition : step.ResumePolicy.ReplayPostcondition),
            After = Observation(plan, complete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition)
        };
    }

    private static OfflineMigrationApplyJournalEntry Proof(OfflineMigrationApplyJournalVerifier verifier)
        => verifier.PendingUnit! with
        {
            Sequence = verifier.Last!.Sequence + 1, State = OfflineMigrationApplyJournalState.StepVerified,
            PreviousDigest = verifier.Last.ContentDigest, ContentDigest = string.Empty
        };

    // A lock-only native command stub establishes the production executor's pre-write
    // refusal boundary. It cannot execute DDL, transactions, or semantic operations and
    // is not evidence of PostgreSQL/provider correctness or successful migration.
    private sealed class LockOnlyConnection(bool allowReadOnlyAdmission = false) : DbConnection
    {
        internal List<string> Commands { get; } = [];
        internal int TransactionAttempts { get; private set; }
        internal int TransactionDisposals { get; set; }
        internal int WriteAttempts { get; set; }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "fixture-database";
        public override string DataSource => "fixture-instance";
        public override string ServerVersion => "fixture";
        public override ConnectionState State => ConnectionState.Open;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close() { }
        public override void Open() { }
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
        {
            TransactionAttempts++;
            if (allowReadOnlyAdmission)
            {
                return new ReadOnlyTransaction(this, isolationLevel);
            }
            throw new NotSupportedException("fixture_transaction_forbidden");
        }
        protected override DbCommand CreateDbCommand() => new LockOnlyCommand(this);
    }

    private sealed class LockOnlyCommand(LockOnlyConnection owner) : DbCommand
    {
        private readonly ParameterList _parameters = new();
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string CommandText { get; set; } = string.Empty;
        public override int CommandTimeout { get; set; }
        public override CommandType CommandType { get; set; }
        public override bool DesignTimeVisible { get; set; }
        public override UpdateRowSource UpdatedRowSource { get; set; }
        protected override DbConnection? DbConnection { get; set; } = owner;
        protected override DbTransaction? DbTransaction { get; set; }
        protected override DbParameterCollection DbParameterCollection => _parameters;
        public override void Cancel() { }
        public override void Prepare() { }
        public override int ExecuteNonQuery()
        {
            owner.WriteAttempts++;
            throw new NotSupportedException("fixture_write_forbidden");
        }
        public override object ExecuteScalar()
        {
            if (CommandText == "SELECT to_regclass('public.__fsus_schema_offline_apply_journal') IS NOT NULL")
            {
                Assert.Empty(_parameters.Values);
                owner.Commands.Add(CommandText);
                return false;
            }

            Assert.Contains(CommandText, new[]
            {
                "SELECT pg_try_advisory_lock(hashtext(@name))", "SELECT pg_advisory_unlock(hashtext(@name))"
            });
            Assert.Single(_parameters.Values);
            Assert.Equal(OfflineMigrationHost.StateLockConstant, _parameters.Values[0].Value);
            owner.Commands.Add(CommandText);
            return true;
        }
        protected override DbParameter CreateDbParameter() => Substitute.For<DbParameter>();
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
            => throw new NotSupportedException("fixture_reader_forbidden");
    }

    private sealed class ReadOnlyTransaction(LockOnlyConnection owner, IsolationLevel isolationLevel) : DbTransaction
    {
        public override IsolationLevel IsolationLevel => isolationLevel;
        protected override DbConnection DbConnection => owner;
        public override void Commit() => throw new NotSupportedException("fixture_commit_forbidden");
        public override void Rollback() { }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { owner.TransactionDisposals++; }
            base.Dispose(disposing);
        }
    }

    private sealed class FixtureOperationRegistry : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
            => new ObserveNothingOperation(operation);
    }

    private sealed class ObserveNothingOperation(OfflineMigrationProviderOperation identity) : OfflineMigrationApplyOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_semantic_observation_forbidden");
        internal override Task<OfflineMigrationApplyUnit> ExecuteAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_semantic_operation_forbidden");
    }

    private sealed class ParameterList : DbParameterCollection
    {
        internal List<DbParameter> Values { get; } = [];
        public override int Count => Values.Count;
        public override object SyncRoot => this;
        public override int Add(object value) { Values.Add((DbParameter)value); return Values.Count - 1; }
        public override void AddRange(Array values) { foreach (object value in values) { Add(value); } }
        public override void Clear() => Values.Clear();
        public override bool Contains(object value) => Values.Contains((DbParameter)value);
        public override bool Contains(string value) => IndexOf(value) >= 0;
        public override void CopyTo(Array array, int index) => ((System.Collections.ICollection)Values).CopyTo(array, index);
        public override System.Collections.IEnumerator GetEnumerator() => Values.GetEnumerator();
        public override int IndexOf(object value) => Values.IndexOf((DbParameter)value);
        public override int IndexOf(string parameterName) => Values.FindIndex(value => value.ParameterName == parameterName);
        public override void Insert(int index, object value) => Values.Insert(index, (DbParameter)value);
        public override void Remove(object value) => Values.Remove((DbParameter)value);
        public override void RemoveAt(int index) => Values.RemoveAt(index);
        public override void RemoveAt(string parameterName) => Values.RemoveAt(IndexOf(parameterName));
        protected override DbParameter GetParameter(int index) => Values[index];
        protected override DbParameter GetParameter(string parameterName) => Values[IndexOf(parameterName)];
        protected override void SetParameter(int index, DbParameter value) => Values[index] = value;
        protected override void SetParameter(string parameterName, DbParameter value)
        {
            int index = IndexOf(parameterName);
            if (index < 0) { Values.Add(value); } else { Values[index] = value; }
        }
    }
}
