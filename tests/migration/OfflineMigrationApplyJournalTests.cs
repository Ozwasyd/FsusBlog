using System.Collections.Immutable;
using System.Data;
using System.Data.Common;

using Microsoft.Data.Sqlite;

using NSubstitute;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationApplyJournalTests
{
    private static readonly string s_identityDigest = new('a', 64);
    private static readonly DateTimeOffset s_recordedAt = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void First_entry_is_the_original_successfully_accepted_attempt_start_across_forks_and_resume()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Assert.Null(verifier.First);
        OfflineMigrationApplyJournalEntry rejected = Seal(Control(plan, verifier,
            OfflineMigrationApplyJournalState.AttemptStarted) with
        {
            Attempt = 2
        });
        Assert.Throws<InvalidOperationException>(() => verifier.Accept(rejected));
        Assert.Null(verifier.First);
        Assert.Null(verifier.Last);

        OfflineMigrationApplyJournalEntry first = Seal(Control(plan, verifier,
            OfflineMigrationApplyJournalState.AttemptStarted));
        verifier.Accept(first);
        OfflineMigrationApplyJournalVerifier fork = verifier.Fork();
        Assert.Same(first, fork.First);
        Accept(fork, Control(plan, fork, OfflineMigrationApplyJournalState.RecoveryRequired,
            failure: "offline_apply_prior_attempt_interrupted"));
        Accept(fork, Control(plan, fork, OfflineMigrationApplyJournalState.AttemptStarted, attempt: 2)
            with
        {
            RecordedAt = s_recordedAt.AddMinutes(1)
        });
        Assert.Same(first, fork.First);
        Assert.Equal(s_recordedAt, fork.First!.RecordedAt);
        Assert.Equal(s_recordedAt.AddMinutes(1), fork.Last!.RecordedAt);
        Assert.Same(first, verifier.First);
        Assert.Same(first, verifier.Last);
    }

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
            Unit(plan, verifier, complete: true) with
            {
                State = OfflineMigrationApplyJournalState.StepVerified
            }));
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
        OfflineMigrationPredicateObservation failed = unit.After! with
        {
            ActualFacts = [new("rows", "999")]
        };
        failed = failed with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(failed)
        };
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
        Accept(verifier, Unit(plan, verifier, complete: true, rows: 2, watermark: "key-2") with
        {
            Attempt = 2
        });
        Accept(verifier, Proof(verifier) with
        {
            Attempt = 2
        });
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted, attempt: 2));
        Assert.True(verifier.Completed);
    }

    [Fact]
    public void Empty_plan_is_never_a_successful_apply_plan()
    {
        OfflineMigrationPlan plan = Plan() with
        {
            OrderedSteps = []
        };
        plan = plan with
        {
            ContentDigest = OfflineMigrationPlanCodec.ComputeContentDigest(plan)
        };
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
            plan, Artifact(plan) with
            {
                Sha256 = plan.ContentDigest
            }, "invocation"));
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
            Unit(plan, verifier, complete: true) with
            {
                State = OfflineMigrationApplyJournalState.BatchCommitted
            }));
        Assert.Null(verifier.PendingUnit);
    }

    [Theory]
    [InlineData("unrelated-predicate")]
    [InlineData("changed-before-facts")]
    public void Resealed_step_proof_cannot_replace_the_committed_unit_before(string changed)
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: true));
        OfflineMigrationApplyJournalEntry proof = Proof(verifier);
        OfflineMigrationPredicateObservation before = changed == "unrelated-predicate"
            ? proof.Before! with
            {
                PredicateReference = "unrelated-owner-predicate"
            }
            : proof.Before! with
            {
                ExpectedFacts = [new("rows", "999")],
                ActualFacts = [new("rows", "999")]
            };
        before = before with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(before)
        };
        Assert.True(before.ExpectedFacts.SequenceEqual(before.ActualFacts));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, proof with { Before = before }));
        Assert.Empty(verifier.StepProofs);
        Assert.Equal(2, verifier.Last!.Sequence);
    }

    [Fact]
    public void Crash_recovery_proof_may_use_the_exact_reobserved_committed_target()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: true));
        OfflineMigrationPredicateObservation target = verifier.PendingUnit!.After!;
        Assert.Equal(plan.OrderedSteps[0].TargetPostcondition, target.PredicateReference);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.RecoveryRequired,
            failure: "offline_apply_prior_attempt_interrupted"));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted, attempt: 2));
        Accept(verifier, Proof(verifier) with
        {
            Attempt = 2,
            Before = target
        });
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted, attempt: 2));
        Assert.True(verifier.Completed);
        Assert.Single(verifier.StepProofs);
        Assert.Equal(target.ContentDigest, verifier.StepProofs[0].Before!.ContentDigest);
        Assert.Equal(verifier.Last!.ContentDigest, Checkpoint(verifier).JournalHead.EntryDigest);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("zero")]
    [InlineData("infinite")]
    [InlineData("unsupported-timer-range")]
    public async Task Missing_or_invalid_cleanup_budget_rejects_before_native_lock_or_write(string invalid)
    {
        TimeSpan? budget = invalid switch
        {
            "missing" => null,
            "zero" => TimeSpan.Zero,
            "infinite" => Timeout.InfiniteTimeSpan,
            "unsupported-timer-range" => TimeSpan.MaxValue,
            _ => throw new InvalidOperationException()
        };
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: budget),
            connection, admission, registry, CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains(invalid == "unsupported-timer-range" ? "offline_apply_cleanup_budget_invalid"
            : "offline_apply_cleanup_budget_required", result.Codes);
        Assert.Empty(connection.Commands);
        Assert.Equal(0, connection.WriteAttempts);
        Assert.Equal(0, connection.TransactionAttempts);
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Fact]
    public async Task Unlock_failure_preserves_first_apply_failure_and_records_cleanup_failure_separately()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection(failUnlock: true);
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan),
            new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)), connection,
            Substitute.For<IOfflineMigrationPlanAdmission>(), new MissingOfflineMigrationApplyOperationRegistry(), CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.RecoveryRequired, result.Status);
        Assert.Equal("offline_apply_rejected", result.Codes[0]);
        Assert.Contains("offline_apply_session_cleanup_required", result.Codes);
        Assert.DoesNotContain("fixture_private_unlock_detail", string.Join(';', result.Codes));
        Assert.Equal(0, connection.CloseAttempts);
        Assert.Equal(0, connection.WriteAttempts);
    }

    [Fact]
    public async Task Native_cleanup_await_uses_independent_finite_budget_and_does_not_claim_disposal()
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection(awaitUnlockCancellation: true);
        Task<OfflineMigrationApplyResult> pending = OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan),
            new("invocation", 1, true, CleanupBudget: TimeSpan.FromMilliseconds(20)), connection,
            Substitute.For<IOfflineMigrationPlanAdmission>(), new MissingOfflineMigrationApplyOperationRegistry(), CancellationToken.None);
        OfflineMigrationApplyResult result = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(OfflineMigrationApplyStatus.RecoveryRequired, result.Status);
        Assert.Equal("offline_apply_rejected", result.Codes[0]);
        Assert.Contains("offline_apply_cleanup_budget_exhausted", result.Codes);
        Assert.Contains("offline_apply_session_cleanup_required", result.Codes);
        Assert.True(connection.UnlockAwaitEnded);
        Assert.Equal(0, connection.CloseAttempts);
        Assert.Equal(0, connection.WriteAttempts);
    }

    [Theory]
    [InlineData("main-cancel")]
    [InlineData("operation-fault")]
    public async Task Transaction_disposal_fault_does_not_replace_the_first_in_flight_failure(string first)
    {
        OfflineMigrationPlan plan = Plan();
        using var connection = new LockOnlyConnection(allowReadOnlyAdmission: true, failTransactionDisposal: true);
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
                if (first == "main-cancel")
                {
                    call.Arg<CancellationToken>().ThrowIfCancellationRequested();
                }
                throw new InvalidOperationException("fixture_private_operation_fault");
            });
        Task<OfflineMigrationApplyResult> pending = OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan),
            new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)), connection,
            admission, new FixtureOperationRegistry(), cancellation.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(pending.IsCompleted);
            Assert.Equal(0, connection.WriteAttempts);
            if (first == "main-cancel")
            {
                cancellation.Cancel();
            }
            release.TrySetResult();
            OfflineMigrationApplyResult result = await pending;
            Assert.Equal(OfflineMigrationApplyStatus.RecoveryRequired, result.Status);
            Assert.Equal(first == "main-cancel" ? "offline_apply_cancelled" : "offline_apply_rejected", result.Codes[0]);
            Assert.Contains("offline_apply_disposal_terminal_unknown", result.Codes);
            Assert.DoesNotContain("fixture_private_operation_fault", string.Join(';', result.Codes));
            Assert.DoesNotContain("fixture_private_disposal_fault", string.Join(';', result.Codes));
            Assert.Equal(1, connection.TransactionDisposals);
            Assert.Equal(0, connection.WriteAttempts);
            Assert.Null(result.Checkpoint);
            Assert.Equal("SELECT pg_advisory_unlock(hashtext(@name))", connection.Commands[^1]);
        }
        finally
        {
            release.TrySetResult();
            await pending;
        }
    }

    [Fact]
    public async Task Unsupported_native_provider_is_rejected_before_connection_or_admission_use()
    {
        OfflineMigrationPlan plan = Plan(provider: CurrentSchemaProviderKind.MySql);
        DbConnection connection = Substitute.For<DbConnection>();
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)),
            connection, admission, registry, CancellationToken.None);
        Assert.Equal(OfflineMigrationApplyStatus.Failed, result.Status);
        Assert.Contains("offline_apply_native_connection_mismatch", result.Codes);
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, false, CleanupBudget: TimeSpan.FromSeconds(1)),
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)),
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)),
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan) with
            {
                Sha256 = new('b', 64)
            },
            new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)), connection, admission, registry, CancellationToken.None);
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)),
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
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan), new("invocation", 1, true, CleanupBudget: TimeSpan.FromSeconds(1)),
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

    [Fact]
    public void Media_operation_cannot_use_the_no_journal_execute_route()
    {
        OfflineMigrationPlan plan = Plan();
        var operation = new FixtureMediaOperation(plan.OrderedSteps[0].Operations[0]);
        Assert.Throws<InvalidOperationException>(() =>
        {
            _ = operation.ExecuteAsync(plan.OrderedSteps[0], null,
                Substitute.For<DbConnection>(), Substitute.For<DbTransaction>(), default);
        });
    }

    [Fact]
    public void Media_owner_requires_durable_preparation_publication_and_atomic_committed_unit()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, Unit(plan, verifier, complete: true)));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalVerifier staged = verifier.Fork();
        Accept(staged, MediaEntry(plan, staged, OfflineMigrationApplyJournalState.MediaPublished));
        Assert.Throws<InvalidOperationException>(() => staged.Complete(Checkpoint(staged)));
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPrepared, verifier.PendingMedia!.State);
        Accept(staged, MediaUnit(plan, staged));
        Accept(staged, Proof(staged));
        Accept(staged, Control(plan, staged, OfflineMigrationApplyJournalState.ApplyCompleted));
        staged.Complete(Checkpoint(staged));
        Assert.True(staged.Completed);
        Assert.Null(staged.PendingMedia);
        Assert.Single(staged.StepProofs);
        Assert.NotNull(staged.StepProofs[0].Media!.GenerationIdentity);
    }

    [Fact]
    public void Media_publication_cannot_skip_preparation_or_repeat_a_parent_cas()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished)));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared)));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished)));
        Assert.Equal(3, verifier.Last!.Sequence);
    }

    [Theory]
    [InlineData("invocation")]
    [InlineData("run")]
    [InlineData("plan-bytes")]
    [InlineData("source")]
    [InlineData("manifest")]
    [InlineData("source-root")]
    [InlineData("target-root")]
    [InlineData("directory")]
    public void Resealed_media_publication_cannot_change_the_prepared_binding(string changed)
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalEntry entry = MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished);
        OfflineMigrationMediaJournalEvidence evidence = entry.Media!;
        ArticleMediaBinding binding = evidence.Binding;
        evidence = changed == "invocation" ? evidence with
        {
            InvocationId = "other-opaque-invocation"
        } : evidence with
        {
            Binding = changed switch
            {
                "run" => binding with { RunId = Guid.Parse("33333333-3333-3333-3333-333333333333") },
                "plan-bytes" => binding with { PlanArtifactSha256 = plan.ContentDigest },
                "source" => binding with { SourceContentDigest = new('c', 64) },
                "manifest" => binding with { ManifestDigest = new('c', 64) },
                "source-root" => binding with { SourceRootIdentity = "other-source" },
                "target-root" => binding with { TargetRootIdentity = "other-target" },
                "directory" => binding with { TargetDirectoryName = "other-generation" },
                _ => throw new InvalidOperationException()
            }
        };
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, entry with { Media = evidence }));
        Assert.Equal(2, verifier.Last!.Sequence);
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPrepared, verifier.PendingMedia!.State);
    }

    [Fact]
    public void Durable_preparation_recovers_the_exact_opaque_invocation_and_owned_run_pair()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalEntry prepared = verifier.PendingMedia!;
        Assert.Equal("invocation", prepared.Media!.InvocationId);
        Assert.NotEqual(prepared.Media.Binding.RunId.ToString("N"), prepared.Media.InvocationId);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.RecoveryRequired,
            failure: "offline_apply_prior_attempt_interrupted"));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted, attempt: 2));
        Assert.Same(prepared, verifier.PendingMedia);
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished) with
        {
            Attempt = 2
        });
        Accept(verifier, MediaUnit(plan, verifier) with
        {
            Attempt = 2
        });
        Accept(verifier, Proof(verifier) with
        {
            Attempt = 2
        });
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted, attempt: 2));
        Assert.True(verifier.Completed);
        Assert.Equal(s_recordedAt, verifier.First!.RecordedAt);
        Assert.Equal(prepared.Media.Binding, verifier.StepProofs[0].Media!.Binding);
    }

    [Fact]
    public void V2_media_round_trip_retains_raw_binding_and_v1_null_media_bytes_are_unchanged()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        OfflineMigrationApplyJournalEntry control = Seal(Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        byte[] originalShape = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
        {
            control.Format,
            control.Plan,
            control.PlanContentDigest,
            control.Database,
            control.InvocationId,
            control.Sequence,
            control.Attempt,
            control.StepId,
            control.OperationReference,
            control.Mode,
            control.State,
            control.IdempotencyKey,
            control.WatermarkBefore,
            control.WatermarkAfter,
            control.HighWatermark,
            control.RowsProcessed,
            control.ExpectedRows,
            control.UnitComplete,
            control.Before,
            control.After,
            control.PreviousDigest,
            control.ContentDigest,
            control.FailureCode,
            control.RecordedAt
        });
        Assert.Equal(originalShape, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(control));
        verifier.Accept(control);
        OfflineMigrationApplyJournalEntry prepared = Seal(MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        byte[] bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(prepared);
        OfflineMigrationApplyJournalEntry decoded = System.Text.Json.JsonSerializer.Deserialize<OfflineMigrationApplyJournalEntry>(bytes)!;
        Assert.Equal(prepared.Media, decoded.Media);
        Assert.Equal(prepared.ContentDigest, OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(decoded));
        verifier.Accept(decoded);
        Assert.StartsWith("offline-apply/v2/", OfflineMigrationApplyJournalVerifier.Reference(decoded).Reference);
    }

    [Fact]
    public void Unbound_or_nonmedia_owner_cannot_admit_resealed_media_events()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Assert.Throws<InvalidOperationException>(() => Accept(verifier,
            MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared)));
        Assert.Throws<InvalidOperationException>(() => verifier.BindOperationOwners(new FixtureMediaRegistry()));
        Assert.Equal(1, verifier.Last!.Sequence);
    }

    [Fact]
    public async Task Failed_actual_journal_append_does_not_advance_the_staged_media_chain()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier committed = MediaVerifier(plan);
        Accept(committed, Control(plan, committed, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(committed, MediaEntry(plan, committed, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalVerifier staged = committed.Fork();
        DbConnection connection = Substitute.For<DbConnection>();
        connection.State.Returns(ConnectionState.Open);
        DbTransaction transaction = Substitute.For<DbTransaction>();
        transaction.Connection.Returns(connection);
        transaction.IsolationLevel.Returns(IsolationLevel.RepeatableRead);
        DbCommand command = Substitute.For<DbCommand>();
        command.Parameters.Returns(new ParameterList());
        command.CreateParameter().Returns(_ => Substitute.For<DbParameter>());
        command.ExecuteNonQueryAsync(Arg.Any<CancellationToken>()).Returns(_ => Task.FromException<int>(
            new InvalidOperationException("fixture_native_append_failure")));
        connection.CreateCommand().Returns(command);
        var journal = new OfflineMigrationArticleMediaJournal(committed, staged, connection, transaction, 1);
        await Assert.ThrowsAsync<InvalidOperationException>(() => journal.RecordPublishedAsync(
            new(committed.PendingMedia!.Media!.Binding, "verified-generation"), ArticleMediaJournalState.Prepared, default));
        Assert.Same(committed.PendingMedia, staged.PendingMedia);
        Assert.Same(committed.Last, staged.Last);
        transaction.DidNotReceive().Commit();
        transaction.DidNotReceive().Rollback();
        connection.DidNotReceive().Open();
    }

    [Fact]
    public async Task Publication_appends_original_seven_bindings_on_graph_transaction_without_committing()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier committed = MediaVerifier(plan);
        Accept(committed, Control(plan, committed, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(committed, MediaEntry(plan, committed, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalVerifier staged = committed.Fork();
        DbConnection connection = Substitute.For<DbConnection>();
        connection.State.Returns(ConnectionState.Open);
        DbTransaction transaction = Substitute.For<DbTransaction>();
        transaction.Connection.Returns(connection);
        transaction.IsolationLevel.Returns(IsolationLevel.RepeatableRead);
        DbCommand command = Substitute.For<DbCommand>();
        var parameters = new ParameterList();
        command.Parameters.Returns(parameters);
        command.CreateParameter().Returns(_ => Substitute.For<DbParameter>());
        command.ExecuteNonQueryAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(1));
        connection.CreateCommand().Returns(command);
        var journal = new OfflineMigrationArticleMediaJournal(committed, staged, connection, transaction, 1);
        ArticleMediaBinding binding = committed.PendingMedia!.Media!.Binding;
        Assert.Equal(ArticleMediaJournalState.Prepared, await journal.RequirePreparedAsync(binding, default));
        await journal.RecordPublishedAsync(new(binding, "verified-generation"), ArticleMediaJournalState.Prepared, default);
        Assert.Equal(ArticleMediaJournalState.MediaPublished, await journal.RequirePreparedAsync(binding, default));
        Assert.Equal("verified-generation", journal.RequirePublished().GenerationIdentity);
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPrepared, committed.PendingMedia.State);
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPublished, staged.PendingMedia!.State);
        Assert.Same(transaction, command.Transaction);
        Assert.Equal(new[] { "@plan", "@database", "@invocation", "@sequence", "@entry", "@parent", "@payload" },
            parameters.Values.Select(static value => value.ParameterName).ToArray());
        Assert.Equal(committed.Last!.ContentDigest, parameters.Values[5].Value);
        Assert.Contains(OfflineMigrationStateStore.ApplyJournalTableName, command.CommandText);
        transaction.DidNotReceive().Commit();
        transaction.DidNotReceive().Rollback();
        connection.DidNotReceive().Open();
    }

    [Fact]
    public void Media_owner_cannot_admit_a_checkpointed_partial_graph_mode()
    {
        OfflineMigrationPlan plan = Plan(OfflineMigrationExecutionMode.CheckpointedBatch);
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Assert.Throws<InvalidOperationException>(() => verifier.BindOperationOwners(new FixtureMediaRegistry()));
        Assert.Null(verifier.First);
        Assert.Null(verifier.Last);
    }

    [Fact]
    public void Resealed_unit_cannot_swap_the_physically_published_generation()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished));
        OfflineMigrationApplyJournalEntry unit = MediaUnit(plan, verifier);
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, unit with
        {
            Media = unit.Media! with
            {
                GenerationIdentity = "other-generation"
            }
        }));
        Assert.Null(verifier.PendingUnit);
    }

    [Theory]
    [InlineData("unrelated-reference")]
    [InlineData("changed-facts")]
    public void Publication_must_retain_the_original_prepared_source_predicate(string changed)
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalVerifier verifier = MediaVerifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPrepared));
        OfflineMigrationApplyJournalEntry published = MediaEntry(plan, verifier, OfflineMigrationApplyJournalState.MediaPublished);
        OfflineMigrationPredicateObservation before = changed == "unrelated-reference"
            ? published.Before! with
            {
                PredicateReference = "unrelated-owner"
            }
            : published.Before! with
            {
                ExpectedFacts = [new("rows", "999")],
                ActualFacts = [new("rows", "999")]
            };
        before = before with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(before)
        };
        Assert.Throws<InvalidOperationException>(() => Accept(verifier, published with { Before = before }));
        Assert.Equal(OfflineMigrationApplyJournalState.MediaPrepared, verifier.PendingMedia!.State);
    }

    [Fact]
    public async Task Journal_append_retains_first_cancellation_when_command_disposal_also_fails()
    {
        OfflineMigrationPlan plan = Plan();
        OfflineMigrationApplyJournalEntry entry = Seal(Control(plan, Verifier(plan), OfflineMigrationApplyJournalState.AttemptStarted));
        DbConnection connection = Substitute.For<DbConnection>();
        DbTransaction transaction = Substitute.For<DbTransaction>();
        DbCommand command = Substitute.For<DbCommand>();
        command.Parameters.Returns(new ParameterList());
        command.CreateParameter().Returns(_ => Substitute.For<DbParameter>());
        var first = new OperationCanceledException("fixture_original_cancel");
        command.ExecuteNonQueryAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<int>(first));
        command.DisposeAsync().Returns(ValueTask.FromException(new InvalidOperationException("fixture_cleanup_private_detail")));
        connection.CreateCommand().Returns(command);
        OperationCanceledException actual = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            OfflineMigrationStateStore.AppendApplyJournalAsync(connection, transaction, entry, default));
        Assert.Same(first, actual);
        Assert.Equal("offline_apply_journal_command_disposal_failed", actual.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey]);
        transaction.DidNotReceive().Commit();
        transaction.DidNotReceive().Rollback();
    }

    [Fact]
    public async Task Journal_budget_counts_actual_utf8_bytes_before_any_native_command()
    {
        OfflineMigrationPlan plan = Plan();
        ImmutableArray<OfflineMigrationFact> facts = Enumerable.Range(0, 96)
            .Select(index => new OfflineMigrationFact($"fact-{index:D3}", new string('漢', 1024))).ToImmutableArray();
        OfflineMigrationApplyJournalEntry entry = Unit(plan, Verifier(plan), complete: true);
        OfflineMigrationPredicateObservation before = entry.Before! with
        {
            ExpectedFacts = facts,
            ActualFacts = facts
        };
        OfflineMigrationPredicateObservation after = entry.After! with
        {
            ExpectedFacts = facts,
            ActualFacts = facts
        };
        before = before with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(before)
        };
        after = after with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(after)
        };
        entry = Seal(entry with
        {
            Before = before,
            After = after
        });
        // UnsafeRelaxedJsonEscaping is not the producer contract: the actual default
        // JSON encoder escapes these characters, so assert only the original byte cap.
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(entry)) > 1_048_576);
        DbConnection connection = Substitute.For<DbConnection>();
        DbTransaction transaction = Substitute.For<DbTransaction>();
        await Assert.ThrowsAsync<InvalidOperationException>(() => OfflineMigrationStateStore.AppendApplyJournalAsync(
            connection, transaction, entry, default));
        Assert.Empty(connection.ReceivedCalls());
        Assert.Empty(transaction.ReceivedCalls());
    }

    [Theory]
    [InlineData("success-result", "released")]
    [InlineData("unknown-result", "released")]
    [InlineData("cancelled-result", "released")]
    [InlineData("cancelled-positive", "released")]
    [InlineData("success-result", "refused")]
    [InlineData("success-result", "failed")]
    [InlineData("cancelled-positive", "exhausted")]
    public async Task PostgreSql_acquisition_failure_retains_effect_custody_until_original_cleanup(string acquisition, string cleanup)
    {
        // These command controls enter the real executor's failure boundary; they
        // are not native PostgreSQL execution or a successful migration proof.
        OfflineMigrationPlan plan = Plan();
        var commands = PostgreSqlLockCommands();
        using var cancellation = new CancellationTokenSource();
        bool knownAcquired = acquisition is "success-result" or "cancelled-positive";
        bool mainCancelled = acquisition is "cancelled-result" or "cancelled-positive";
        Exception first = acquisition == "success-result"
            ? new InvalidOperationException("fixture_acquisition_disposal_private_detail")
            : mainCancelled ? new OperationCanceledException(cancellation.Token)
                : new InvalidOperationException("fixture_acquisition_result_private_detail");
        commands.Acquire.ExecuteScalarAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            if (mainCancelled)
                cancellation.Cancel();
            if (knownAcquired)
                return Task.FromResult<object?>(true);
            return Task.FromException<object?>(first);
        });
        commands.Acquire.DisposeAsync().Returns(ValueTask.FromException(knownAcquired
            ? first : new InvalidOperationException("fixture_secondary_disposal_private_detail")));
        bool cleanupAwaitEnded = false;
        commands.Unlock.ExecuteScalarAsync(Arg.Any<CancellationToken>()).Returns(async call =>
        {
            CancellationToken cleanupToken = call.Arg<CancellationToken>();
            Assert.NotEqual(cancellation.Token, cleanupToken);
            Assert.True(cleanupToken.CanBeCanceled);
            if (cleanup == "failed")
                throw new InvalidOperationException("fixture_unlock_private_detail");
            if (cleanup == "exhausted")
            {
                try
                {
                    await Task.Delay(Timeout.Infinite, cleanupToken);
                }
                finally { cleanupAwaitEnded = true; }
            }
            return (object?)(cleanup != "refused");
        });
        var admission = Substitute.For<IOfflineMigrationPlanAdmission>();
        var registry = Substitute.For<IOfflineMigrationApplyOperationRegistry>();
        OfflineMigrationApplyResult result = await OfflineMigrationExecutor.ApplyAsync(
            new VerifiedOfflineMigrationPlan(plan), Artifact(plan),
            new("invocation", 1, true, CleanupBudget: cleanup == "exhausted" ? TimeSpan.FromMilliseconds(20) : TimeSpan.FromSeconds(1)),
            commands.Connection, admission, registry, cancellation.Token);
        Assert.Equal(OfflineMigrationApplyStatus.RecoveryRequired, result.Status);
        Assert.Equal(mainCancelled ? "offline_apply_cancelled" : "offline_apply_rejected", result.Codes[0]);
        Assert.Contains("offline_apply_journal_command_disposal_failed", result.Codes);
        if (cleanup == "refused")
            Assert.Contains("offline_apply_unlock_not_observed", result.Codes);
        if (!knownAcquired || cleanup is "failed" or "exhausted")
            Assert.Contains("offline_apply_session_cleanup_required", result.Codes);
        if (cleanup == "exhausted")
        {
            Assert.True(cleanupAwaitEnded);
            Assert.Contains("offline_apply_cleanup_budget_exhausted", result.Codes);
        }
        Assert.Equal("offline_apply_journal_command_disposal_failed", first.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey]);
        Assert.DoesNotContain("fixture_", string.Join(';', result.Codes));
        Assert.Null(result.Checkpoint);
        Assert.Empty(result.StepProofs);
        Assert.Equal("SELECT pg_try_advisory_lock(hashtext(@name))", commands.Acquire.CommandText);
        Assert.Equal(OfflineMigrationHost.StateLockConstant, Assert.Single(commands.Acquire.Parameters.Cast<DbParameter>()).Value);
        if (knownAcquired)
        {
            Assert.Equal("SELECT pg_advisory_unlock(hashtext(@name))", commands.Unlock.CommandText);
            Assert.Equal(OfflineMigrationHost.StateLockConstant, Assert.Single(commands.Unlock.Parameters.Cast<DbParameter>()).Value);
        }
        else
        {
            // Uncertain submission does not authorize decrementing a caller's
            // pre-existing reentrant lock, even on this same retained connection.
            Assert.Empty(commands.Unlock.Parameters.Cast<DbParameter>());
        }
        Assert.Equal(1, commands.Acquire.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteScalarAsync)));
        Assert.Equal(knownAcquired ? 1 : 0, commands.Unlock.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteScalarAsync)));
        commands.Connection.DidNotReceive().Close();
        Assert.Empty(admission.ReceivedCalls());
        Assert.Empty(registry.ReceivedCalls());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task PostgreSql_lock_scalar_custody_precedes_command_disposal(bool observedSuccess)
    {
        var commands = PostgreSqlLockCommands();
        var first = new InvalidOperationException("fixture_first_private_detail");
        commands.Acquire.ExecuteScalarAsync(Arg.Any<CancellationToken>()).Returns(observedSuccess
            ? Task.FromResult<object?>(true) : Task.FromException<object?>(first));
        commands.Acquire.DisposeAsync().Returns(ValueTask.FromException(observedSuccess
            ? first : new InvalidOperationException("fixture_cleanup_private_detail")));
        commands.Unlock.ExecuteScalarAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<object?>(true));
        var native = new OfflineMigrationApplyNativeSession(commands.Connection, CurrentSchemaProviderKind.PostgreSql);
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => native.AcquireAsync(default));
        Assert.Same(first, actual);
        Assert.True(native.CleanupRequired);
        Assert.Equal("offline_apply_journal_command_disposal_failed", actual.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey]);
        if (observedSuccess)
        {
            Assert.True(await native.ReleaseAsync(default));
            Assert.False(native.CleanupRequired);
        }
        else
        {
            InvalidOperationException cleanup = await Assert.ThrowsAsync<InvalidOperationException>(() => native.ReleaseAsync(default));
            Assert.Equal("offline_apply_postgresql_lock_ownership_unobserved", cleanup.Message);
            Assert.True(native.CleanupRequired);
            Assert.DoesNotContain(commands.Unlock.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteScalarAsync));
        }
        commands.Connection.DidNotReceive().Close();
    }

    [Fact]
    public async Task PostgreSql_observed_busy_result_does_not_release_a_lock_not_acquired_by_this_attempt()
    {
        var commands = PostgreSqlLockCommands();
        commands.Acquire.ExecuteScalarAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<object?>(false));
        var native = new OfflineMigrationApplyNativeSession(commands.Connection, CurrentSchemaProviderKind.PostgreSql);
        Assert.False(await native.AcquireAsync(default));
        Assert.False(native.CleanupRequired);
        Assert.DoesNotContain(commands.Unlock.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteScalarAsync));
        commands.Connection.DidNotReceive().Close();
    }

    private static (DbConnection Connection, DbCommand Acquire, DbCommand Unlock) PostgreSqlLockCommands()
    {
        DbConnection connection = Substitute.For<DbConnection>();
        connection.State.Returns(ConnectionState.Open);
        DbCommand acquire = Substitute.For<DbCommand>();
        DbCommand unlock = Substitute.For<DbCommand>();
        foreach (DbCommand command in new[] { acquire, unlock })
        {
            command.Parameters.Returns(new ParameterList());
            command.CreateParameter().Returns(_ => Substitute.For<DbParameter>());
        }
        connection.CreateCommand().Returns(acquire, unlock);
        return (connection, acquire, unlock);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void Provider_exact_committed_checkpoint_replay_preserves_identity_and_rejects_cross_provider(CurrentSchemaProviderKind provider)
    {
        // This is a pure journal control, not a native provider or migration success claim.
        OfflineMigrationPlan plan = Plan(provider: provider);
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        Accept(verifier, Unit(plan, verifier, complete: true));
        Accept(verifier, Proof(verifier));
        Accept(verifier, Control(plan, verifier, OfflineMigrationApplyJournalState.ApplyCompleted));
        verifier.Complete(Checkpoint(verifier));
        Assert.Equal(provider, verifier.Last!.Database.Provider);
        Assert.True(verifier.Completed);
        OfflineMigrationApplyJournalVerifier replay = Verifier(plan);
        OfflineMigrationApplyJournalEntry first = Seal(Control(plan, replay, OfflineMigrationApplyJournalState.AttemptStarted));
        CurrentSchemaProviderKind other = provider == CurrentSchemaProviderKind.PostgreSql ? CurrentSchemaProviderKind.MySql : CurrentSchemaProviderKind.PostgreSql;
        Assert.Throws<InvalidOperationException>(() => replay.Accept(Seal(first with { Database = first.Database with { Provider = other } })));
        Assert.Null(replay.First);
        Assert.Null(replay.Last);
        replay.Accept(first);
        Assert.Equal(provider, replay.First!.Database.Provider);
    }

    [Theory]
    [InlineData(OfflineMigrationExecutionMode.Transaction)]
    [InlineData(OfflineMigrationExecutionMode.CheckpointedBatch)]
    public void Undeclared_mysql_atomic_operation_cannot_reinterpret_the_sealed_mode(OfflineMigrationExecutionMode mode)
    {
        OfflineMigrationPlan plan = Plan(mode, CurrentSchemaProviderKind.MySql);
        OfflineMigrationProviderOperation identity = plan.OrderedSteps[0].Operations.Single(value => value.Provider == CurrentSchemaProviderKind.MySql);
        var operation = new ObserveNothingOperation(identity);
        Assert.Equal(mode, operation.Identity.Mode);
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(operation.RequireAtomicNativeExecution);
        Assert.Equal("offline_apply_mysql_atomic_operation_owner_missing", failure.Message);
        Assert.Equal(identity, operation.Identity);
        Assert.Equal(mode, plan.OrderedSteps[0].Operations.Single(value => value.Provider == CurrentSchemaProviderKind.MySql).Mode);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void Transactional_provider_contract_does_not_rewrite_the_operation(CurrentSchemaProviderKind provider)
    {
        OfflineMigrationPlan plan = Plan(provider: provider);
        OfflineMigrationProviderOperation identity = plan.OrderedSteps[0].Operations.Single(value => value.Provider == provider);
        var operation = new ObserveNothingOperation(identity);
        operation.RequireAtomicNativeExecution();
        Assert.Equal(identity, operation.Identity);
        Assert.Equal(OfflineMigrationExecutionMode.Transaction, operation.Identity.Mode);
    }

    [Fact]
    public async Task Sqlite_native_file_lock_is_retained_between_committed_units_and_released_without_closing_caller()
    {
        // A real task-owned native SQLite component control, not a complete sealed apply.
        using var fixture = new NativeSqliteFixture();
        using var token = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var session = new OfflineMigrationApplyNativeSession(fixture.Connection, CurrentSchemaProviderKind.Sqlite);
        Assert.True(await session.AcquireAsync(token.Token));
        try
        {
            await using (DbTransaction transaction = await session.BeginAsync(token.Token))
            {
                await using DbCommand command = OfflineMigrationStateStore.NativeCommand(fixture.Connection, transaction,
                    "INSERT INTO business(value) VALUES ('committed')");
                await command.ExecuteNonQueryAsync(token.Token);
                await transaction.CommitAsync(token.Token);
            }
            await using var other = new SqliteConnection(fixture.ConnectionString);
            await other.OpenAsync(token.Token);
            await using DbCommand blocked = other.CreateCommand();
            blocked.CommandText = "SELECT count(*) FROM business";
            SqliteException failure = await Assert.ThrowsAsync<SqliteException>(() => blocked.ExecuteScalarAsync(token.Token));
            Assert.Equal(5, failure.SqliteErrorCode);
            Assert.True(await session.ReleaseAsync(token.Token));
            Assert.Equal(ConnectionState.Open, fixture.Connection.State);
            Assert.Equal(1L, await blocked.ExecuteScalarAsync(token.Token));
        }
        finally
        {
            if (session.CleanupRequired)
                await session.ReleaseAsync(token.Token);
        }
    }

    [Fact]
    public async Task Sqlite_caller_transaction_is_not_nested_rolled_back_or_disposed_by_apply_lock()
    {
        using var fixture = new NativeSqliteFixture();
        using var token = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using DbTransaction caller = fixture.Connection.BeginTransaction();
        await using DbCommand write = OfflineMigrationStateStore.NativeCommand(fixture.Connection, caller,
            "INSERT INTO business(value) VALUES ('caller')");
        await write.ExecuteNonQueryAsync(token.Token);
        var session = new OfflineMigrationApplyNativeSession(fixture.Connection, CurrentSchemaProviderKind.Sqlite);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => session.AcquireAsync(token.Token));
        Assert.Equal("offline_apply_caller_transaction_active", failure.Message);
        Assert.False(session.CleanupRequired);
        Assert.Same(fixture.Connection, caller.Connection);
        await using DbCommand count = OfflineMigrationStateStore.NativeCommand(fixture.Connection, caller, "SELECT count(*) FROM business");
        Assert.Equal(1L, await count.ExecuteScalarAsync(token.Token));
        await caller.RollbackAsync(token.Token);
        Assert.Equal(ConnectionState.Open, fixture.Connection.State);
    }

    [Fact]
    public async Task Sqlite_actual_journal_and_business_rollback_together_and_parent_unique_cas_is_native()
    {
        using var fixture = new NativeSqliteFixture();
        using var token = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        OfflineMigrationPlan plan = Plan(provider: CurrentSchemaProviderKind.Sqlite);
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        OfflineMigrationApplyJournalEntry first = Seal(Control(plan, verifier, OfflineMigrationApplyJournalState.AttemptStarted));
        var session = new OfflineMigrationApplyNativeSession(fixture.Connection, CurrentSchemaProviderKind.Sqlite);
        Assert.True(await session.AcquireAsync(token.Token));
        try
        {
            await using (DbTransaction transaction = await session.BeginAsync(token.Token))
            {
                await OfflineMigrationStateStore.EnsureApplyJournalAsync(fixture.Connection, transaction, token.Token);
                await OfflineMigrationStateStore.AppendApplyJournalAsync(fixture.Connection, transaction, first, token.Token);
                await using DbCommand command = OfflineMigrationStateStore.NativeCommand(fixture.Connection, transaction,
                    "INSERT INTO business(value) VALUES ('rolled-back')");
                await command.ExecuteNonQueryAsync(token.Token);
                await transaction.RollbackAsync(token.Token);
            }
            await using (DbTransaction transaction = await session.BeginAsync(token.Token))
            {
                Assert.False(await OfflineMigrationApplyJournalDialect.ExistsAsync(CurrentSchemaProviderKind.Sqlite, fixture.Connection, transaction, token.Token));
                await OfflineMigrationStateStore.EnsureApplyJournalAsync(fixture.Connection, transaction, token.Token);
                await OfflineMigrationStateStore.AppendApplyJournalAsync(fixture.Connection, transaction, first, token.Token);
                await transaction.CommitAsync(token.Token);
            }
            await using (DbTransaction transaction = await session.BeginAsync(token.Token))
            {
                OfflineMigrationApplyJournalEntry sibling = Seal(first with
                {
                    Sequence = 2,
                    RecordedAt = s_recordedAt.AddSeconds(1)
                });
                SqliteException failure = await Assert.ThrowsAsync<SqliteException>(() => OfflineMigrationStateStore.AppendApplyJournalAsync(
                    fixture.Connection, transaction, sibling, token.Token));
                Assert.Equal(19, failure.SqliteErrorCode);
                var request = new OfflineMigrationApplyRequest("invocation", 2, true,
                    new(OfflineMigrationApplyJournalVerifier.Reference(first), "invocation", 1), TimeSpan.FromSeconds(1));
                OfflineMigrationApplyJournalVerifier read = Verifier(plan);
                await OfflineMigrationStateStore.ReadApplyJournalAsync(fixture.Connection, transaction,
                    plan.ContentDigest, plan.Source.Database, request, read, token.Token);
                Assert.Equal(first.ContentDigest, read.Last!.ContentDigest);
                Assert.Equal(1, read.Last.Sequence);
                await using DbCommand count = OfflineMigrationStateStore.NativeCommand(fixture.Connection, transaction, "SELECT count(*) FROM business");
                Assert.Equal(0L, await count.ExecuteScalarAsync(token.Token));
                await transaction.RollbackAsync(token.Token);
            }
        }
        finally { await session.ReleaseAsync(token.Token); }
    }

    [Fact]
    public async Task Sqlite_actual_trigger_drift_is_rejected_before_journal_read_or_append()
    {
        using var fixture = new NativeSqliteFixture();
        using var token = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var session = new OfflineMigrationApplyNativeSession(fixture.Connection, CurrentSchemaProviderKind.Sqlite);
        Assert.True(await session.AcquireAsync(token.Token));
        try
        {
            await using DbTransaction transaction = await session.BeginAsync(token.Token);
            await OfflineMigrationStateStore.EnsureApplyJournalAsync(fixture.Connection, transaction, token.Token);
            await using DbCommand trigger = OfflineMigrationStateStore.NativeCommand(fixture.Connection, transaction,
                $"CREATE TRIGGER changed_control AFTER INSERT ON {OfflineMigrationStateStore.ApplyJournalTableName} BEGIN INSERT INTO business(value) VALUES ('hidden'); END");
            await trigger.ExecuteNonQueryAsync(token.Token);
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OfflineMigrationStateStore.ValidateApplyJournalAsync(fixture.Connection, transaction, token.Token));
            Assert.Equal("offline_apply_journal_physical_shape_changed", failure.Message);
            await transaction.RollbackAsync(token.Token);
        }
        finally { await session.ReleaseAsync(token.Token); }
    }

    private sealed class NativeSqliteFixture : IDisposable
    {
        private readonly string _directory = Directory.CreateTempSubdirectory("fsusblog-apply-journal-").FullName;
        internal string ConnectionString
        {
            get;
        }
        internal SqliteConnection Connection
        {
            get;
        }
        internal NativeSqliteFixture()
        {
            ConnectionString = new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(_directory, "owned.db"),
                Pooling = false,
                DefaultTimeout = 1
            }.ToString();
            Connection = new SqliteConnection(ConnectionString);
            Connection.Open();
            using SqliteCommand create = Connection.CreateCommand();
            create.CommandText = "CREATE TABLE business(value TEXT NOT NULL)";
            create.ExecuteNonQuery();
        }
        public void Dispose()
        {
            Connection.Dispose();
            // Only this fixture's newly created, task-owned directory is removed.
            Directory.Delete(_directory, recursive: true);
        }
    }

    private static OfflineMigrationApplyJournalVerifier MediaVerifier(OfflineMigrationPlan plan)
    {
        OfflineMigrationApplyJournalVerifier verifier = Verifier(plan);
        verifier.BindOperationOwners(new FixtureMediaRegistry());
        return verifier;
    }

    private static OfflineMigrationMediaJournalEvidence MediaBinding(OfflineMigrationPlan plan)
        => new("invocation", new(Guid.Parse("22222222-2222-2222-2222-222222222222"), Artifact(plan).Sha256,
            plan.ContentDigest, plan.Source.ContentDigest, new('b', 64), "actual-source-root", "actual-target-root", "generation"), null);

    private static OfflineMigrationApplyJournalEntry MediaEntry(OfflineMigrationPlan plan,
        OfflineMigrationApplyJournalVerifier verifier, OfflineMigrationApplyJournalState state)
    {
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationProviderOperation operation = step.Operations[0];
        OfflineMigrationMediaJournalEvidence media = verifier.PendingMedia?.Media ?? MediaBinding(plan);
        return Control(plan, verifier, state) with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
            StepId = step.StepId,
            OperationReference = operation.OperationReference,
            Mode = operation.Mode,
            IdempotencyKey = step.IdempotencyDefinition,
            Before = Observation(plan, step.SourcePrecondition),
            Media = state == OfflineMigrationApplyJournalState.MediaPublished ? media with
            {
                GenerationIdentity = "verified-generation"
            } : media
        };
    }

    private static OfflineMigrationApplyJournalEntry MediaUnit(OfflineMigrationPlan plan, OfflineMigrationApplyJournalVerifier verifier)
        => Unit(plan, verifier, complete: true) with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
            Media = verifier.PendingMedia!.Media
        };

    private sealed class FixtureMediaRegistry : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
            => new FixtureMediaOperation(operation);
    }

    private sealed class FixtureMediaOperation(OfflineMigrationProviderOperation identity) : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_media_observation_unavailable");
        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocationId, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken) => throw new NotSupportedException("fixture_media_source_capability_unavailable");
        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_media_execution_unavailable");
    }

    private static OfflineMigrationPlan Plan(OfflineMigrationExecutionMode mode = OfflineMigrationExecutionMode.Transaction,
        CurrentSchemaProviderKind provider = CurrentSchemaProviderKind.PostgreSql, bool destructive = false)
    {
        var database = new CurrentSchemaDatabaseIdentity(provider, "instance", "database");
        var source = new OfflineMigrationSourceObservation(database, "extractor", "v1", [], [], [], s_identityDigest);
        var artifact = new CurrentSchemaArtifactReference("fixture-backup", s_identityDigest);
        var backup = new OfflineMigrationBackupObservation(artifact, artifact, artifact, "fixture-owner", "v1",
            s_recordedAt, s_recordedAt, "fixture-snapshot", s_identityDigest, s_identityDigest,
            source, source with
            {
                Database = database with
                {
                    DatabaseId = "restored"
                }
            },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, s_identityDigest)).ToImmutableArray());
        var step = new OfflineMigrationStep("owned-step", "owned-source", "owned-target", [], "owned-idempotency", destructive,
            new("v1", mode == OfflineMigrationExecutionMode.Transaction ? 0 : 1, "owned-watermark", "owned-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "fixture-operation", s_identityDigest, s_identityDigest, mode)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1",
            [new("fixture-profile", "v1", "fixture-owner", [nameof(Complete_transaction_chain_requires_committed_unit_then_verified_step)],
                step.StepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(value => new OfflineMigrationSourceShape(
                    value, source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        var dag = new OfflineMigrationDag("fixture-dag", "v1", [step]);
        var target = new CurrentSchemaTargetIdentity("v1", "v1", "v1", s_identityDigest, s_identityDigest);
        var tool = new CurrentSchemaVerifierIdentity(new('a', 40), s_identityDigest, s_identityDigest, s_identityDigest);
        OfflineMigrationPlan plan = OfflineMigrationPlanBuilder.Create(source, backup, target, tool, registry, dag,
            s_recordedAt, TimeSpan.FromHours(1));
        // The normal pure builder/verifier validates this synthetic fixture's closure.
        // None of these fixture observations are a real backup, DB proof, or operation grant.
        return OfflineMigrationPlanVerifier.Verify(plan, source, backup, target, tool, registry, dag,
            s_recordedAt, TimeSpan.FromHours(1)).Plan;
    }

    private static CurrentSchemaArtifactReference Artifact(OfflineMigrationPlan plan)
        => new("fixture-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
    private static OfflineMigrationApplyJournalVerifier Verifier(OfflineMigrationPlan plan) => new(plan, Artifact(plan), "invocation");
    private static OfflineMigrationApplyCheckpoint Checkpoint(OfflineMigrationApplyJournalVerifier verifier)
        => new(OfflineMigrationApplyJournalVerifier.Reference(verifier.Last!), "invocation", verifier.Last!.Sequence);
    private static OfflineMigrationApplyJournalEntry Seal(OfflineMigrationApplyJournalEntry entry)
        => entry with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(entry)
        };
    private static void Accept(OfflineMigrationApplyJournalVerifier verifier, OfflineMigrationApplyJournalEntry entry)
        => verifier.Accept(Seal(entry));
    private static OfflineMigrationApplyJournalEntry Control(OfflineMigrationPlan plan, OfflineMigrationApplyJournalVerifier verifier,
        OfflineMigrationApplyJournalState state, int attempt = 1, string? failure = null)
        => new(OfflineMigrationApplyJournalVerifier.Format, Artifact(plan), plan.ContentDigest, plan.Source.Database, "invocation",
            (verifier.Last?.Sequence ?? 0) + 1, attempt, null, null, null, state, null, null, null, null,
            0, 0, false, null, null, verifier.Last?.ContentDigest ?? OfflineMigrationApplyJournalVerifier.GenesisDigest,
            string.Empty, failure, s_recordedAt);
    private static OfflineMigrationPredicateObservation Observation(OfflineMigrationPlan plan, string predicate)
    {
        OfflineMigrationProviderOperation operation = plan.OrderedSteps[0].Operations[0];
        var observation = new OfflineMigrationPredicateObservation(predicate, operation.OperationReference,
            operation.OperationSourceDigest, operation.SemanticDigest, [new("rows", "2")], [new("rows", "2")], string.Empty);
        return observation with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
        };
    }

    private static OfflineMigrationApplyJournalEntry Unit(OfflineMigrationPlan plan, OfflineMigrationApplyJournalVerifier verifier,
        bool complete, long rows = 2, string? watermark = null)
    {
        OfflineMigrationStep step = plan.OrderedSteps[0];
        OfflineMigrationProviderOperation operation = step.Operations[0];
        return Control(plan, verifier, operation.Mode == OfflineMigrationExecutionMode.Transaction
            ? OfflineMigrationApplyJournalState.TransactionCommitted : OfflineMigrationApplyJournalState.BatchCommitted) with
        {
            StepId = step.StepId,
            OperationReference = operation.OperationReference,
            Mode = operation.Mode,
            IdempotencyKey = step.IdempotencyDefinition,
            RowsProcessed = rows,
            ExpectedRows = 2,
            UnitComplete = complete,
            WatermarkBefore = verifier.PendingUnit?.WatermarkAfter,
            WatermarkAfter = watermark,
            HighWatermark = operation.Mode == OfflineMigrationExecutionMode.CheckpointedBatch ? "key-2" : null,
            Before = Observation(plan, verifier.PendingUnit is null ? step.SourcePrecondition : step.ResumePolicy.ReplayPostcondition),
            After = Observation(plan, complete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition)
        };
    }

    private static OfflineMigrationApplyJournalEntry Proof(OfflineMigrationApplyJournalVerifier verifier)
        => verifier.PendingUnit! with
        {
            Sequence = verifier.Last!.Sequence + 1,
            State = OfflineMigrationApplyJournalState.StepVerified,
            PreviousDigest = verifier.Last.ContentDigest,
            ContentDigest = string.Empty
        };

    // A lock-only native command stub establishes the production executor's pre-write
    // refusal boundary. It cannot execute DDL, transactions, or semantic operations and
    // is not evidence of PostgreSQL/provider correctness or successful migration.
    private sealed class LockOnlyConnection(bool allowReadOnlyAdmission = false, bool failUnlock = false,
        bool awaitUnlockCancellation = false, bool failTransactionDisposal = false) : DbConnection
    {
        internal List<string> Commands { get; } = [];
        internal int TransactionAttempts
        {
            get; private set;
        }
        internal int TransactionDisposals
        {
            get; set;
        }
        internal int WriteAttempts
        {
            get; set;
        }
        internal int CloseAttempts
        {
            get; private set;
        }
        internal bool UnlockAwaitEnded
        {
            get; set;
        }
        internal bool FailUnlock => failUnlock;
        internal bool AwaitUnlockCancellation => awaitUnlockCancellation;
        internal bool FailTransactionDisposal => failTransactionDisposal;
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "fixture-database";
        public override string DataSource => "fixture-instance";
        public override string ServerVersion => "fixture";
        public override ConnectionState State => ConnectionState.Open;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close()
        {
            CloseAttempts++;
        }
        public override void Open()
        {
        }
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
        public override int CommandTimeout
        {
            get; set;
        }
        public override CommandType CommandType
        {
            get; set;
        }
        public override bool DesignTimeVisible
        {
            get; set;
        }
        public override UpdateRowSource UpdatedRowSource
        {
            get; set;
        }
        protected override DbConnection? DbConnection { get; set; } = owner;
        protected override DbTransaction? DbTransaction
        {
            get; set;
        }
        protected override DbParameterCollection DbParameterCollection => _parameters;
        public override void Cancel()
        {
        }
        public override void Prepare()
        {
        }
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
            if (owner.FailUnlock && CommandText.StartsWith("SELECT pg_advisory_unlock", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("fixture_private_unlock_detail");
            }
            return true;
        }
        public override async Task<object?> ExecuteScalarAsync(CancellationToken cancellationToken)
        {
            if (owner.AwaitUnlockCancellation && CommandText.StartsWith("SELECT pg_advisory_unlock", StringComparison.Ordinal))
            {
                try
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                    throw new InvalidOperationException("fixture_cleanup_should_cancel");
                }
                finally
                {
                    owner.UnlockAwaitEnded = true;
                }
            }

            cancellationToken.ThrowIfCancellationRequested();
            return ExecuteScalar();
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
        public override void Rollback()
        {
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                owner.TransactionDisposals++;
                if (owner.FailTransactionDisposal)
                {
                    throw new InvalidOperationException("fixture_private_disposal_fault");
                }
            }
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
        public override int Add(object value)
        {
            Values.Add((DbParameter)value);
            return Values.Count - 1;
        }
        public override void AddRange(Array values)
        {
            foreach (object value in values)
            {
                Add(value);
            }
        }
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
            if (index < 0)
            {
                Values.Add(value);
            }
            else
            {
                Values[index] = value;
            }
        }
    }
}
