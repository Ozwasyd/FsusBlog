using System.Collections.Immutable;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkAtomicExecutorTests
{
    public static IEnumerable<object[]> Operations()
        => ArticleBulkOperationRegistry.Current.Operations
            .Where(static operation => operation.Strategy == ArticleBulkExecutionStrategy.AllOrNothing)
            .Select(static operation => new object[] { operation.Id });

    [Theory]
    [MemberData(nameof(Operations))]
    public async Task EachRegisteredAtomicOperationHasOneGroupCommitAndIdempotentReplay(string operationId)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync(operationId);
        var owner = new AtomicDouble(fixture.Plan);
        var executor = new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner);
        ArticleBulkExecutionResult result = await executor.ExecuteAsync(fixture.Plan, fixture.Input);
        ArticleBulkExecutionResult duplicate = await executor.ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Equal(ArticleBulkExecutionState.Completed, result.Head.State);
        Assert.Equal(ArticleBulkGroupCommitOutcome.Committed, result.Receipt!.GroupCommitOutcome);
        Assert.Equal(3, result.Receipt.SucceededCount);
        Assert.False(result.Receipt.Partial);
        Assert.Equal(result.Receipt.ContentDigest, duplicate.Receipt!.ContentDigest);
        Assert.Equal(1, owner.PrepareCalls);
        Assert.Equal(1, owner.CommitCalls);
        Assert.Equal(1, owner.DisposeCalls);
        Assert.Equal(1, fixture.Selection.Calls);
        Assert.Equal(3, fixture.Authority.GroupProofChecks);
    }

    [Fact]
    public async Task PrepareRejectionSealsVerifiedZeroWriteWithoutStartingCommit()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        var owner = new AtomicDouble(fixture.Plan)
        {
            RejectPrepare = true
        };
        ArticleBulkExecutionResult result = await new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Equal(ArticleBulkExecutionState.Failed, result.Head.State);
        Assert.False(result.Head.GroupCommitStarted);
        Assert.Equal(0, owner.CommitCalls);
        Assert.Equal(0, result.Receipt!.SucceededCount);
        Assert.Equal(3, result.Receipt.FailedCount);
        Assert.NotNull(result.Receipt.ZeroWriteProofDigest);
        Assert.Equal(2, fixture.Authority.GroupProofChecks);
        Assert.All(fixture.Journal.Receipts, static receipt => Assert.Empty(receipt.SideEffects));
    }

    [Fact]
    public async Task FailureProofIsCheckedBeforeAnyItemTerminalOrOverallResult()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.restore");
        fixture.Authority.RejectGroupProof = true;
        var owner = new AtomicDouble(fixture.Plan)
        {
            RejectPrepare = true
        };
        await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
                .ExecuteAsync(fixture.Plan, fixture.Input));
        Assert.Empty(fixture.Journal.Receipts);
        Assert.Null(fixture.Journal.Terminal);
        Assert.Equal(0, owner.CommitCalls);
    }

    [Fact]
    public async Task PreparationCancelAbortsAndReleasesWhileCommitCancelCompletesWholeSet()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("schedule.change");
        using var stop = new CancellationTokenSource();
        var owner = new AtomicDouble(fixture.Plan)
        {
            AfterPrepare = stop.Cancel
        };
        ArticleBulkExecutionResult cancelled = await new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input, stop.Token);
        Assert.Equal(ArticleBulkExecutionState.Cancelled, cancelled.Head.State);
        Assert.Equal(3, cancelled.Receipt!.CancelledCount);
        Assert.False(cancelled.Head.GroupCommitStarted);
        Assert.Equal(1, owner.AbortCalls);
        Assert.Equal(1, owner.DisposeCalls);

        fixture = await ArticleBulkExecutorTestFixture.CreateAsync("schedule.change");
        using var commitStop = new CancellationTokenSource();
        owner = new AtomicDouble(fixture.Plan)
        {
            DuringCommit = commitStop.Cancel
        };
        ArticleBulkExecutionResult committed = await new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input, commitStop.Token);
        Assert.Equal(ArticleBulkExecutionState.Completed, committed.Head.State);
        Assert.Equal(3, committed.Receipt!.SucceededCount);
        Assert.Equal(0, owner.AbortCalls);
    }

    [Fact]
    public async Task LostCommitConclusionIsRecoveryRequiredWithoutZeroWriteClaim()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.inbox-to-draft");
        var owner = new AtomicDouble(fixture.Plan)
        {
            LoseCommitConclusion = true
        };
        var executor = new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner);
        ArticleBulkExecutionResult result = await executor.ExecuteAsync(fixture.Plan, fixture.Input);
        ArticleBulkExecutionResult replay = await executor.ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, result.Head.State);
        Assert.Equal(ArticleBulkGroupCommitOutcome.UnknownRecovery, result.Receipt!.GroupCommitOutcome);
        Assert.Null(result.Receipt.ZeroWriteProofDigest);
        Assert.Null(result.Receipt.GroupReceiptDigest);
        Assert.Equal(3, result.Receipt.FailedCount);
        Assert.Equal(result.Receipt.ContentDigest, replay.Receipt!.ContentDigest);
        Assert.Equal(1, owner.CommitCalls);
    }

    [Fact]
    public async Task TenThousandItemsUseOneCommitOrBlockBeforePrepareAtOwnerBudget()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive", 10_000);
        var unsupported = new AtomicDouble(fixture.Plan)
        {
            MaximumAtomicItems = 100
        };
        await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, unsupported)
                .ExecuteAsync(fixture.Plan, fixture.Input));
        Assert.Equal(0, unsupported.PrepareCalls);
        Assert.Empty(fixture.Journal.Events);

        var owner = new AtomicDouble(fixture.Plan);
        ArticleBulkExecutionResult result = await new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.Equal(1, owner.CommitCalls);
        Assert.Equal(10_000, result.Receipt!.SucceededCount);
        Assert.Equal(40, result.Receipt.ItemReceiptChunks.Length);
        Assert.Equal(46, fixture.Journal.Events.Count);
    }

    [Fact]
    public async Task WrongStrategyOrUnsupportedAtomicityDoesNotSpawnBusinessCommands()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        var owner = new AtomicDouble(fixture.Plan);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            new ArticleBulkAtomicExecutor(fixture.Framework, fixture.Journal, owner)
                .ExecuteAsync(fixture.Plan, fixture.Input));
        Assert.Equal(0, owner.PrepareCalls);
        Assert.Empty(fixture.Journal.Events);
    }

    private sealed class AtomicDouble(ArticleBulkPlan plan) : IArticleBulkAtomicCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public int MaximumAtomicItems { get; init; } = 10_000;
        internal int PrepareCalls
        {
            get; private set;
        }
        internal int CommitCalls
        {
            get; private set;
        }
        internal int AbortCalls
        {
            get; private set;
        }
        internal int DisposeCalls
        {
            get; private set;
        }
        internal bool RejectPrepare
        {
            get; init;
        }
        internal bool LoseCommitConclusion
        {
            get; init;
        }
        internal Action? AfterPrepare
        {
            get; init;
        }
        internal Action? DuringCommit
        {
            get; init;
        }

        public Task<ArticleBulkAtomicPreparation> PrepareAsync(
            ArticleBulkAtomicCommand command,
            CancellationToken cancellationToken)
        {
            PrepareCalls++;
            AfterPrepare?.Invoke();
            return Task.FromResult(RejectPrepare
                ? new ArticleBulkAtomicPreparation(null, Outcome(command, committed: false))
                : new ArticleBulkAtomicPreparation(new LeaseDouble(this, command), null));
        }

        private static ArticleBulkAtomicOutcome Outcome(
            ArticleBulkAtomicCommand command,
            bool committed,
            bool cancelled = false)
            => new(
                committed ? ArticleBulkGroupCommitOutcome.Committed : ArticleBulkGroupCommitOutcome.RejectedZeroWrite,
                committed ? "committed-all" : cancelled ? "cancelled-before-commit" : "prepare-rejected",
                committed ? ArticleBulkDigest.Of("test-single-commit") : null,
                committed ? null : ArticleBulkDigest.Of("test-zero-write-snapshots"),
                ArticleBulkExecutorTestFixture.Stream(command.Plan.Items.Select(item =>
                    ArticleBulkExecutorTestFixture.ItemReceipt(
                        command.Request, command.Plan, item,
                        committed ? ArticleBulkItemStatus.Succeeded
                            : cancelled ? ArticleBulkItemStatus.Cancelled : ArticleBulkItemStatus.Failed,
                        committed ? "committed-all" : "not-committed"))),
                cancelled);

        private sealed class LeaseDouble(AtomicDouble owner, ArticleBulkAtomicCommand command)
            : IArticleBulkAtomicPreparedCommand
        {
            public string PreparationReceiptDigest => ArticleBulkDigest.Of("test-prepare");

            public Task<ArticleBulkAtomicOutcome> CommitAsync(CancellationToken cancellationToken)
            {
                owner.CommitCalls++;
                owner.DuringCommit?.Invoke();
                Assert.False(cancellationToken.IsCancellationRequested);
                if (owner.LoseCommitConclusion)
                {
                    throw new IOException("test-no-commit-conclusion");
                }
                return Task.FromResult(Outcome(command, committed: true));
            }

            public Task<ArticleBulkAtomicOutcome> AbortAsync(CancellationToken cancellationToken)
            {
                owner.AbortCalls++;
                return Task.FromResult(Outcome(command, committed: false, cancelled: true));
            }

            public ValueTask DisposeAsync()
            {
                owner.DisposeCalls++;
                return ValueTask.CompletedTask;
            }
        }
    }
}
