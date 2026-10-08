using System.Runtime.CompilerServices;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

// Protocol inputs only: these tests do not qualify any real DB transaction, rollback or side effect.
public sealed class ArticleBulkRecoveryProtocolTests
{
    [Fact]
    public async Task PreparationExceptionStaysUnknownAcrossRealFileJournalRestartAndIndependentVerification()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        string directory = Path.Combine(Path.GetTempPath(), $"bulk-release-recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var options = new ArticleBulkFileJournalOptions(directory,
                ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename);
            var journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            var framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var owner = new UnprovedPreparation(fixture.Plan);
            ArticleBulkExecutionResult result = await new ArticleBulkAtomicExecutor(framework, journal, owner)
                .ExecuteAsync(fixture.Plan, fixture.Input);
            Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, result.Head.State);
            Assert.Null(result.Receipt);

            journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            ArticleBulkAdmission restored = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan,
                fixture.Input, default);
            ArticleBulkJournalHead resumed = await framework.ResumeAsync(result.Request, fixture.Plan, restored.Head);
            await framework.VerifyExecutionAsync(result.Request, fixture.Plan, resumed);
            ArticleBulkIdempotencyResolution resolution = await journal.ResolveIdempotencyAsync(
                fixture.Input.IdempotencyKey, result.Request.ExecutionIdentityDigest, default);
            Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, resumed.State);
            Assert.Equal(ArticleBulkGroupCommitOutcome.UnknownRecovery, resolution.TerminalReceipt!.GroupCommitOutcome);
            Assert.Null(resolution.TerminalReceipt.ZeroWriteProofDigest);
            Assert.False(resolution.TerminalReceipt.RetryEligible);
            Assert.Equal(1, owner.Calls);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task UnknownItemRejectsOrdinaryRetryEvenWithAnExplicitNewRevision()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        var owner = new ItemOwner(fixture.Plan) { Throw = true };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.False(result.Receipt!.RetryEligible);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.CreateRetryAsync(result.Request,
            fixture.Plan, result.Head, "retry-unresolved", new Dictionary<string, string>
            {
                [fixture.Plan.Items.First().ArticleId] = "explicit-new-revision"
            }));
        Assert.Single(fixture.Journal.Events, static entry => entry.Kind == ArticleBulkJournalEventKind.ItemStarted);
        Assert.DoesNotContain(fixture.Journal.Events, static entry => entry.Kind == ArticleBulkJournalEventKind.RetryRequested);
    }

    [Fact]
    public async Task ConclusivelyUnstartedCancelAllowsExactSubsetRetryWithoutChangingOriginalReceipts()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.remove");
        var owner = new ItemOwner(fixture.Plan);
        using var stop = new CancellationTokenSource();
        stop.Cancel();
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input, stop.Token);
        string originalDigest = result.Receipt!.ContentDigest;
        string[] itemDigests = [.. fixture.Journal.Receipts.Select(static receipt => receipt.ContentDigest)];
        Assert.True(result.Receipt.RetryEligible);
        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(result.Request, fixture.Plan,
            result.Head, "retry-cancelled", new Dictionary<string, string>
            {
                [fixture.Plan.Items.ElementAt(1).ArticleId] = "explicit-new-revision"
            });
        Assert.Equal(fixture.Plan.Items.ElementAt(1).ArticleId, Assert.Single(retry.Request.FailedItems).ArticleId);
        Assert.Equal(0, owner.Calls);
        Assert.Equal(originalDigest, fixture.Journal.Terminal!.ContentDigest);
        Assert.Equal(itemDigests, fixture.Journal.Receipts.Select(static receipt => receipt.ContentDigest));
        await fixture.Framework.VerifyExecutionAsync(result.Request, fixture.Plan, retry.Head);
    }

    [Fact]
    public async Task AlreadyAdmittedCancelledItemCannotPretendToBeAnUnstartedRetry()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.add", 1);
        var owner = new ItemOwner(fixture.Plan) { Status = ArticleBulkItemStatus.Cancelled };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.False(result.Receipt!.RetryEligible);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.CreateRetryAsync(result.Request,
            fixture.Plan, result.Head, "retry-started", new Dictionary<string, string>
            {
                [fixture.Plan.Items.First().ArticleId] = "explicit-new-revision"
            }));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SealedConclusiveItemWithMissingAggregateStopsNewAdmissionsAndPreservesItsOutcome(bool succeeded)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add", 2);
        ArticleBulkAdmission admission = await ArticleBulkExecutorProtocol.AdmitAsync(fixture.Framework, fixture.Plan,
            fixture.Input, default);
        ArticleBulkJournalHead head = await ArticleBulkExecutorProtocol.StartAsync(fixture.Framework, fixture.Plan,
            admission.Head, default);
        ArticleBulkPlanItem item = fixture.Plan.Items.First();
        string owner = ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner;
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.ItemAdmitted,
            head.State, articleId: item.ArticleId, nextItemStatus: ArticleBulkItemStatus.Admitted);
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.ItemStarted,
            head.State, articleId: item.ArticleId, commandOwner: owner, expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);
        ArticleBulkItemReceipt receipt = ArticleBulkExecutorTestFixture.ItemReceipt(admission.Request, fixture.Plan,
            item, succeeded ? ArticleBulkItemStatus.Succeeded : ArticleBulkItemStatus.Failed);
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.ItemTerminal,
            head.State, articleId: item.ArticleId, commandOwner: owner,
            commandReceiptDigest: receipt.CanonicalCommandReceiptDigest, itemReceipt: receipt,
            expectedItemStatus: ArticleBulkItemStatus.Executing, nextItemStatus: receipt.ExecutionStatus);
        head = await fixture.Framework.ResumeAsync(admission.Request, fixture.Plan, head);
        Assert.Equal(succeeded ? ArticleBulkExecutionState.Partial : ArticleBulkExecutionState.Failed, head.State);
        Assert.Equal(receipt.ContentDigest, fixture.Journal.Receipts[0].ContentDigest);
        Assert.Equal(1, head.AdmittedCount);
        Assert.Equal(1, head.CancelledCount);
        Assert.True(fixture.Journal.Terminal!.RetryEligible);
        await fixture.Framework.VerifyExecutionAsync(admission.Request, fixture.Plan, head);
    }

    [Fact]
    public async Task UnknownSealedGroupWithNoAggregateFinalizesRecoveryWithoutInventingZeroWrites()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture,
            ArticleBulkGroupCommitOutcome.UnknownRecovery);
        string sealedGroup = fixture.Journal.Events[^1].ContentDigest;
        head = await fixture.Framework.ResumeAsync(request, fixture.Plan, head);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, head.State);
        Assert.Equal(3, fixture.Journal.Terminal!.FailedCount);
        Assert.Null(fixture.Journal.Terminal.ZeroWriteProofDigest);
        Assert.Single(fixture.Journal.Events, static entry => entry.Kind == ArticleBulkJournalEventKind.GroupCommitTerminal);
        Assert.Contains(fixture.Journal.Events, entry => entry.ContentDigest == sealedGroup);
        await fixture.Framework.VerifyExecutionAsync(request, fixture.Plan, head);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task KnownGroupMissingBusinessReceiptsRequiresCanonicalReconciliation(
        bool committed)
    {
        ArticleBulkGroupCommitOutcome outcome = committed
            ? ArticleBulkGroupCommitOutcome.Committed : ArticleBulkGroupCommitOutcome.FailedZeroWrite;
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture, outcome);
        head = await fixture.Framework.ResumeAsync(request, fixture.Plan, head);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, head.State);
        Assert.Equal(outcome, head.GroupCommitOutcome);
        Assert.Null(fixture.Journal.Terminal);
        Assert.Empty(fixture.Journal.Receipts);
        Assert.Equal(head.ContentDigest, (await fixture.Framework.ResumeAsync(request, fixture.Plan, head)).ContentDigest);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CanonicalRecoveryCompletesAnExactKnownReceiptPrefixWithoutReexecutingCommands(
        bool committed)
    {
        ArticleBulkGroupCommitOutcome outcome = committed
            ? ArticleBulkGroupCommitOutcome.Committed : ArticleBulkGroupCommitOutcome.FailedZeroWrite;
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture, outcome);
        ArticleBulkItemReceipt[] receipts = [.. fixture.Plan.Items.Select(item => ArticleBulkExecutorTestFixture.ItemReceipt(
            request, fixture.Plan, item, outcome == ArticleBulkGroupCommitOutcome.Committed
                ? ArticleBulkItemStatus.Succeeded : ArticleBulkItemStatus.Failed))];
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.ReceiptChunkRecorded,
            head.State, receiptChunk: [receipts[0]], reasonCode: "sealed-receipt-prefix");
        fixture.Authority.GroupRecovery = (boundRequest, plan, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(boundRequest.ExecutionIdentityDigest, plan.ContentDigest, outcome,
                outcome == ArticleBulkGroupCommitOutcome.Committed ? ArticleBulkDigest.Of("group") : null,
                outcome == ArticleBulkGroupCommitOutcome.Committed ? null : ArticleBulkDigest.Of("zero"), Stream(receipts)));

        head = await fixture.Framework.ResumeAsync(request, fixture.Plan, head);
        Assert.Equal(outcome == ArticleBulkGroupCommitOutcome.Committed
            ? ArticleBulkExecutionState.Completed : ArticleBulkExecutionState.Failed, head.State);
        Assert.Equal(receipts.Select(static receipt => receipt.ContentDigest),
            fixture.Journal.Receipts.Select(static receipt => receipt.ContentDigest));
        Assert.Single(fixture.Journal.Events, static entry => entry.Kind == ArticleBulkJournalEventKind.GroupCommitStarted);
        Assert.Single(fixture.Journal.Events, static entry => entry.Kind == ArticleBulkJournalEventKind.GroupCommitTerminal);
        await fixture.Framework.VerifyExecutionAsync(request, fixture.Plan, head);
    }

    [Fact]
    public async Task TruncatedKnownGroupRecoveryRetainsItsSealedPrefixAndCanResumeByCanonicalIdentity()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive", 260);
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture,
            ArticleBulkGroupCommitOutcome.Committed);
        ArticleBulkItemReceipt[] receipts = [.. fixture.Plan.Items.Select(item =>
            ArticleBulkExecutorTestFixture.ItemReceipt(request, fixture.Plan, item))];
        fixture.Authority.GroupRecovery = (_, plan, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(request.ExecutionIdentityDigest, plan.ContentDigest,
                ArticleBulkGroupCommitOutcome.Committed, ArticleBulkDigest.Of("group"), null, Stream(receipts.Take(250))));
        Assert.Equal("article-bulk.group-recovery-items-incomplete", (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.ResumeAsync(request, fixture.Plan, head))).Code);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, fixture.Journal.Head!.State);
        Assert.Null(fixture.Journal.Terminal);
        Assert.Equal(250, fixture.Journal.Receipts.Count);
        string[] prefix = [.. fixture.Journal.Receipts.Select(static receipt => receipt.ContentDigest)];

        fixture.Authority.GroupRecovery = (_, plan, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(request.ExecutionIdentityDigest, plan.ContentDigest,
                ArticleBulkGroupCommitOutcome.Committed, ArticleBulkDigest.Of("group"), null, Stream(receipts)));
        head = await fixture.Framework.ResumeAsync(request, fixture.Plan, fixture.Journal.Head);
        Assert.Equal(ArticleBulkExecutionState.Completed, head.State);
        Assert.Equal(260, fixture.Journal.Receipts.Count);
        Assert.Equal(prefix, fixture.Journal.Receipts.Take(250).Select(static receipt => receipt.ContentDigest));
        Assert.Equal(2, fixture.Journal.Events.Count(static entry => entry.Kind == ArticleBulkJournalEventKind.ReceiptChunkRecorded));
    }

    [Fact]
    public async Task CancellationAfterSealedSuccessAllowsPartialExactRetryOfUnstartedArticles()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.add");
        using var stop = new CancellationTokenSource();
        var owner = new ItemOwner(fixture.Plan) { AfterCommand = stop.Cancel };
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, owner)
            .ExecuteAsync(fixture.Plan, fixture.Input, stop.Token);
        Assert.Equal(ArticleBulkExecutionState.Partial, result.Head.State);
        Assert.True(result.Receipt!.RetryEligible);
        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(result.Request, fixture.Plan, result.Head,
            "retry-partial-cancel", new Dictionary<string, string>
            {
                [fixture.Plan.Items.ElementAt(2).ArticleId] = "explicit-new-revision"
            });
        Assert.Equal(fixture.Plan.Items.ElementAt(2).ArticleId, Assert.Single(retry.Request.FailedItems).ArticleId);
        Assert.Equal(1, owner.Calls);
        Assert.Equal(1, result.Receipt.SucceededCount);
        Assert.Equal(2, result.Receipt.CancelledCount);
    }

    [Fact]
    public async Task RecoveryRejectsEvidenceFromAnotherTransactionBeforeAppendingBusinessReceipts()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture,
            ArticleBulkGroupCommitOutcome.Committed);
        fixture.Authority.GroupRecovery = (_, plan, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(ArticleBulkDigest.Of("wrong-transaction"), plan.ContentDigest,
                ArticleBulkGroupCommitOutcome.Committed, ArticleBulkDigest.Of("group"), null, Stream([])));
        Assert.Equal("article-bulk.group-recovery-unbound", (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.ResumeAsync(request, fixture.Plan, head))).Code);
        Assert.Empty(fixture.Journal.Receipts);
        Assert.Null(fixture.Journal.Terminal);
    }

    [Fact]
    public async Task IndependentVerificationRevalidatesCanonicalProofRatherThanTrustingCachedAcceptance()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        (ArticleBulkExecutionRequest request, ArticleBulkJournalHead head) = await StartGroupAsync(fixture,
            ArticleBulkGroupCommitOutcome.Committed);
        ArticleBulkItemReceipt[] receipts = [.. fixture.Plan.Items.Select(item =>
            ArticleBulkExecutorTestFixture.ItemReceipt(request, fixture.Plan, item))];
        fixture.Authority.GroupRecovery = (_, plan, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(request.ExecutionIdentityDigest, plan.ContentDigest,
                ArticleBulkGroupCommitOutcome.Committed, ArticleBulkDigest.Of("group"), null, Stream(receipts)));
        head = await fixture.Framework.ResumeAsync(request, fixture.Plan, head);
        fixture.Authority.RejectGroupProof = true;
        Assert.Equal("test.group-proof-rejected", (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.VerifyExecutionAsync(request, fixture.Plan, head))).Code);
    }

    private static async Task<(ArticleBulkExecutionRequest Request, ArticleBulkJournalHead Head)> StartGroupAsync(
        ArticleBulkExecutorTestFixture fixture,
        ArticleBulkGroupCommitOutcome outcome)
    {
        ArticleBulkAdmission admission = await ArticleBulkExecutorProtocol.AdmitAsync(fixture.Framework, fixture.Plan,
            fixture.Input, default);
        ArticleBulkJournalHead head = await ArticleBulkExecutorProtocol.StartAsync(fixture.Framework, fixture.Plan,
            admission.Head, default);
        string owner = ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner;
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.GroupCommitStarted,
            head.State, commandOwner: owner);
        string? group = outcome == ArticleBulkGroupCommitOutcome.Committed ? ArticleBulkDigest.Of("group") : null;
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.GroupCommitTerminal,
            head.State, commandOwner: owner, commandReceiptDigest: group, groupOutcome: outcome, groupReceiptDigest: group,
            zeroWriteProofDigest: outcome == ArticleBulkGroupCommitOutcome.FailedZeroWrite ? ArticleBulkDigest.Of("zero") : null);
        return (admission.Request, head);
    }

    private static async IAsyncEnumerable<ArticleBulkItemReceipt> Stream(
        IEnumerable<ArticleBulkItemReceipt> receipts,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (ArticleBulkItemReceipt receipt in receipts)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return receipt;
        }
        await Task.CompletedTask;
    }

    private sealed class UnprovedPreparation(ArticleBulkPlan plan) : IArticleBulkAtomicCommandAuthority
    {
        internal int Calls
        {
            get; private set;
        }
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public System.Collections.Immutable.ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public int MaximumAtomicItems => 10_000;
        public Task<ArticleBulkAtomicPreparation> PrepareAsync(ArticleBulkAtomicCommand command,
            CancellationToken cancellationToken)
        {
            Calls++;
            throw new IOException("release is not proved");
        }
    }

    private sealed class ItemOwner(ArticleBulkPlan plan) : IArticleBulkPerItemCommandAuthority
    {
        internal int Calls
        {
            get; private set;
        }
        internal bool Throw
        {
            get; init;
        }
        internal ArticleBulkItemStatus Status { get; init; } = ArticleBulkItemStatus.Succeeded;
        internal Action? AfterCommand
        {
            get; init;
        }
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public System.Collections.Immutable.ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public Task<ArticleBulkItemReceipt> ExecuteAsync(ArticleBulkItemCommand command, CancellationToken cancellationToken)
        {
            Calls++;
            if (Throw)
            {
                throw new IOException("commit conclusion unknown");
            }
            ArticleBulkItemReceipt receipt = ArticleBulkExecutorTestFixture.ItemReceipt(command.Request, command.Plan,
                command.Item, Status);
            AfterCommand?.Invoke();
            return Task.FromResult(receipt);
        }
    }
}
