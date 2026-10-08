using System.Collections.Immutable;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkPerItemExecutorTests
{
    public static IEnumerable<object[]> Operations()
        => ArticleBulkOperationRegistry.Current.Operations
            .Where(static operation => operation.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated)
            .Select(static operation => new object[] { operation.Id });

    [Theory]
    [MemberData(nameof(Operations))]
    public async Task EveryRegisteredOperationUsesExactFrozenItemsAndReplaysWithoutCommands(string operationId)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync(operationId);
        var commands = new CommandDouble(fixture.Plan);
        var executor = new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands);

        ArticleBulkExecutionResult result = await executor.ExecuteAsync(fixture.Plan, fixture.Input);
        ArticleBulkExecutionResult replay = await executor.ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Equal(ArticleBulkExecutionState.Completed, result.Head.State);
        Assert.Equal(3, result.Receipt!.SucceededCount);
        Assert.Equal(result.Receipt.ContentDigest, replay.Receipt!.ContentDigest);
        Assert.Equal(3, commands.Calls.Count);
        Assert.Equal(fixture.Plan.Items.Select(static item => item.ArticleId), commands.Calls.Select(static item => item.Item.ArticleId));
        Assert.Equal(3, commands.Calls.Select(static item => item.ItemIdempotencyKey).Distinct().Count());
        Assert.Equal(1, fixture.Selection.Calls);
        Assert.Equal(1, commands.MaximumActive);
        Assert.All(fixture.Journal.Receipts, receipt => Assert.Equal(
            ArticleBulkOperationRegistry.Get(operationId).MutatesBusinessState,
            receipt.NewRevision is not null));
    }

    [Theory]
    [InlineData("precondition-failure")]
    [InlineData("permission-failure")]
    [InlineData("revision-conflict")]
    [InlineData("product-failure")]
    public async Task ItemFailurePreservesSuccessesAndExactRetryHistory(string reason)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        var commands = new CommandDouble(fixture.Plan)
        {
            FailureReason = reason
        };
        var executor = new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands);
        ArticleBulkExecutionResult result = await executor.ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Equal(ArticleBulkExecutionState.Partial, result.Head.State);
        Assert.Equal(2, result.Receipt!.SucceededCount);
        Assert.Equal(1, result.Receipt.FailedCount);
        Assert.Equal(reason, fixture.Journal.Receipts[1].ReasonCode);
        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(
            result.Request, fixture.Plan, result.Head, "attempt-2",
            new Dictionary<string, string> { ["article-00001"] = "explicit-revision-2" });
        Assert.Equal("article-00001", Assert.Single(retry.Request.FailedItems).ArticleId);
        Assert.Equal(3, fixture.Journal.Receipts.Count);
        Assert.Equal(result.Receipt.ContentDigest, fixture.Journal.Terminal!.ContentDigest);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.CreateRetryAsync(
            result.Request, fixture.Plan, retry.Head, "attempt-3",
            new Dictionary<string, string> { ["article-00000"] = "explicit-revision-3" }));
    }

    [Fact]
    public async Task RetryCanSelectOneExactFailureWithoutIncludingOtherFailures()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        var commands = new CommandDouble(fixture.Plan)
        {
            FailureReason = "revision-conflict",
            FailAll = true
        };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(
            result.Request, fixture.Plan, result.Head, "attempt-subset",
            new Dictionary<string, string> { ["article-00001"] = "explicit-revision-2" });
        Assert.Equal("article-00001", Assert.Single(retry.Request.FailedItems).ArticleId);
        Assert.Equal(3, fixture.Journal.Receipts.Count);
        Assert.All(fixture.Journal.Receipts, static receipt => Assert.Equal(ArticleBulkItemStatus.Failed, receipt.ExecutionStatus));
    }

    [Fact]
    public async Task DurableJournalReplaysSealedExecutionAfterAuthorityRestart()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.remove");
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-bulk-executor-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var options = new ArticleBulkFileJournalOptions(
                directory, ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename);
            var journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            var framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var commands = new CommandDouble(fixture.Plan);
            ArticleBulkExecutionResult first = await new ArticleBulkPerItemExecutor(framework, journal, commands)
                .ExecuteAsync(fixture.Plan, fixture.Input);

            journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            ArticleBulkExecutionResult replay = await new ArticleBulkPerItemExecutor(framework, journal, commands)
                .ExecuteAsync(fixture.Plan, fixture.Input);
            Assert.Equal(first.Receipt!.ContentDigest, replay.Receipt!.ContentDigest);
            Assert.Equal(3, commands.Calls.Count);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task CancelDuringCommandWaitsForTerminalAndStopsRemainingAdmissions()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.add");
        using var stop = new CancellationTokenSource();
        var commands = new CommandDouble(fixture.Plan)
        {
            AfterCommand = stop.Cancel
        };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input, stop.Token);

        Assert.Single(commands.Calls);
        Assert.Equal(ArticleBulkExecutionState.Partial, result.Head.State);
        Assert.Equal(1, result.Receipt!.SucceededCount);
        Assert.Equal(2, result.Receipt.CancelledCount);
        Assert.All(fixture.Journal.Receipts.Skip(1), receipt => Assert.Equal("not-executed-cancelled", receipt.ReasonCode));
    }

    [Fact]
    public async Task UnknownCommandOutcomeStopsCommandsAndRequiresRecovery()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("property.clear");
        var commands = new CommandDouble(fixture.Plan)
        {
            ThrowAfterInvocation = true
        };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Single(commands.Calls);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, result.Head.State);
        Assert.Equal(0, result.Receipt!.SucceededCount);
        Assert.Equal(1, result.Receipt.FailedCount);
        Assert.Equal(2, result.Receipt.CancelledCount);
        Assert.Null(result.Receipt.ZeroWriteProofDigest);
    }

    [Fact]
    public async Task ConcurrentDuplicateReturnsInProgressAndDoesNotInvokeSecondCommand()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.remove", 1);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commands = new CommandDouble(fixture.Plan)
        {
            WaitBeforeReceipt = async () =>
            {
                entered.SetResult();
                await release.Task;
            }
        };
        var executor = new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands);
        Task<ArticleBulkExecutionResult> first = executor.ExecuteAsync(fixture.Plan, fixture.Input);
        await entered.Task;
        ArticleBulkExecutionResult duplicate = await executor.ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.Null(duplicate.Receipt);
        Assert.Equal(ArticleBulkExecutionState.Executing, duplicate.Head.State);
        Assert.Single(commands.Calls);
        release.SetResult();
        Assert.Equal(ArticleBulkExecutionState.Completed, (await first).Head.State);
    }

    [Fact]
    public async Task AtomicPlanAndUnboundAdapterAreRejectedBeforeJournalOrCommands()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        var commands = new CommandDouble(fixture.Plan);
        var executor = new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => executor.ExecuteAsync(fixture.Plan, fixture.Input));
        Assert.Empty(commands.Calls);
        Assert.Empty(fixture.Journal.Events);
    }

    [Fact]
    public async Task TenThousandItemsKeepOneActiveCommandAndFortyReceiptChunks()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("search.reindex", 10_000);
        var commands = new CommandDouble(fixture.Plan);
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.Equal(10_000, commands.Calls.Count);
        Assert.Equal(1, commands.MaximumActive);
        Assert.Equal(40, result.Receipt!.ItemReceiptChunks.Length);
        Assert.Equal(30_004, fixture.Journal.Events.Count);
    }

    private sealed class CommandDouble(ArticleBulkPlan plan) : IArticleBulkPerItemCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        internal List<ArticleBulkItemCommand> Calls { get; } = [];
        internal int MaximumActive
        {
            get; private set;
        }
        internal string? FailureReason
        {
            get; init;
        }
        internal bool ThrowAfterInvocation
        {
            get; init;
        }
        internal bool FailAll
        {
            get; init;
        }
        internal Action? AfterCommand
        {
            get; init;
        }
        internal Func<Task>? WaitBeforeReceipt
        {
            get; init;
        }
        private int _active;

        public async Task<ArticleBulkItemReceipt> ExecuteAsync(
            ArticleBulkItemCommand command,
            CancellationToken cancellationToken)
        {
            Calls.Add(command);
            _active++;
            MaximumActive = Math.Max(MaximumActive, _active);
            try
            {
                if (ThrowAfterInvocation)
                {
                    throw new IOException("test-no-command-conclusion");
                }
                if (WaitBeforeReceipt is not null)
                {
                    await WaitBeforeReceipt();
                }
                AfterCommand?.Invoke();
                Assert.False(cancellationToken.IsCancellationRequested);
                bool failed = (FailAll || command.Item.ArticleId == "article-00001") && FailureReason is not null;
                return ArticleBulkExecutorTestFixture.ItemReceipt(
                    command.Request, plan, command.Item,
                    failed ? ArticleBulkItemStatus.Failed : ArticleBulkItemStatus.Succeeded,
                    failed ? FailureReason! : "succeeded");
            }
            finally
            {
                _active--;
            }
        }
    }
}
