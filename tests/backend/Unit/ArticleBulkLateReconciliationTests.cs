using System.Runtime.CompilerServices;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

// Real fsync journal/restart tests with protocol-only canonical inputs, not DB transaction qualification.
public sealed class ArticleBulkLateReconciliationTests
{
    [Fact]
    public async Task SealedUnknownReachesReadOnlyAuthorityAfterRestartAndNullEvidenceKeepsEveryOriginalByte()
    {
        using Context context = await Context.CreateAsync();
        string[] original = await context.ReceiptDigestsAsync(context.Head);
        int reads = 0;
        context.Fixture.Authority.GroupRecovery = (request, plan, checkpoint) =>
        {
            Assert.Equal(context.Request.ContentDigest, request.ContentDigest);
            Assert.Equal(context.Head.ContentDigest, checkpoint.ContentDigest);
            Assert.Equal(context.Fixture.Plan.ContentDigest, plan.ContentDigest);
            reads++;
            return Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(null);
        };
        context.Restart();
        ArticleBulkJournalHead resumed = await context.ResumeAsync();
        Assert.Equal(1, reads);
        Assert.Equal(context.Head.ContentDigest, resumed.ContentDigest);
        Assert.Equal(original, await context.ReceiptDigestsAsync(resumed));
        Assert.Null(await context.ReadAsync());
        Assert.Equal(context.OriginalReceipt.ContentDigest, (await context.OriginalAsync()).TerminalReceipt!.ContentDigest);
        Assert.Null(context.OriginalReceipt.ZeroWriteProofDigest);
        Assert.False(context.OriginalReceipt.RetryEligible);
    }

    [Theory]
    [InlineData((int)ArticleBulkGroupCommitOutcome.Committed, true)]
    [InlineData((int)ArticleBulkGroupCommitOutcome.RejectedZeroWrite, true)]
    [InlineData((int)ArticleBulkGroupCommitOutcome.FailedZeroWrite, true)]
    [InlineData((int)ArticleBulkGroupCommitOutcome.Committed, false)]
    public async Task LateKnownOutcomeIsAnIndependentImmutableObservationOfTheSameCanonicalTransaction(
        int outcomeValue, bool started)
    {
        ArticleBulkGroupCommitOutcome outcome = (ArticleBulkGroupCommitOutcome)outcomeValue;
        using Context context = await Context.CreateAsync(started: started);
        string[] original = await context.ReceiptDigestsAsync(context.Head);
        ArticleBulkItemReceipt[] canonical = context.CanonicalReceipts(outcome);
        int reads = 0;
        context.Fixture.Authority.GroupRecovery = (request, _, checkpoint) =>
        {
            Assert.Equal(context.Request.ContentDigest, request.ContentDigest);
            Assert.Equal(context.Head.ContentDigest, checkpoint.ContentDigest);
            reads++;
            return Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(context.Evidence(outcome, canonical));
        };
        context.Restart();
        Assert.Equal(context.Head.ContentDigest, (await context.ResumeAsync()).ContentDigest);
        ArticleBulkReconciliationResult reconciliation = Assert.IsType<ArticleBulkReconciliationResult>(await context.ReadAsync());
        Assert.Equal(context.Request.ContentDigest, reconciliation.OriginalRequestDigest);
        Assert.Equal(context.OriginalReceipt.ContentDigest, reconciliation.OriginalTerminalReceiptDigest);
        Assert.Equal(context.Request.ExecutionIdentityDigest, reconciliation.Request.ExecutionIdentityDigest);
        Assert.Equal(context.Request.AttemptId, reconciliation.Request.AttemptId);
        Assert.NotEqual(context.Request.ContentDigest, reconciliation.Request.ContentDigest);
        Assert.NotEqual(context.Request.IdempotencyKey, reconciliation.Request.IdempotencyKey);
        Assert.False(reconciliation.Head.GroupCommitStarted);
        Assert.Equal(outcome == ArticleBulkGroupCommitOutcome.Committed
            ? ArticleBulkExecutionState.Completed : ArticleBulkExecutionState.Failed, reconciliation.Head.State);
        Assert.Equal(outcome, reconciliation.Receipt!.GroupCommitOutcome);
        Assert.Equal(canonical.Select(static item => item.ContentDigest), await context.ReceiptDigestsAsync(reconciliation.Head));
        Assert.Equal(original, await context.ReceiptDigestsAsync(context.Head));
        Assert.Equal(context.OriginalReceipt.ContentDigest, (await context.OriginalAsync()).TerminalReceipt!.ContentDigest);
        ArticleBulkJournalEvent[] events = await context.EventsAsync(reconciliation.Head);
        Assert.DoesNotContain(events, static item => item.Kind is ArticleBulkJournalEventKind.GroupCommitStarted
            or ArticleBulkJournalEventKind.ItemStarted or ArticleBulkJournalEventKind.RetryRequested);
        Assert.Single(events, static item => item.Kind == ArticleBulkJournalEventKind.GroupReconciled);
        context.Restart();
        await context.ResumeAsync();
        Assert.Equal(2, reads);
        Assert.Equal(reconciliation.Head.ContentDigest, (await context.ReadAsync())!.Head.ContentDigest);
    }

    [Theory]
    [InlineData("identity")]
    [InlineData("plan")]
    [InlineData("proof")]
    [InlineData("unknown-zero")]
    public async Task LateForeignOrMalformedEvidenceCannotCreateAnObservationJournal(string defect)
    {
        using Context context = await Context.CreateAsync();
        ArticleBulkGroupRecoveryEvidence evidence = context.Evidence(ArticleBulkGroupCommitOutcome.Committed,
            context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed));
        evidence = defect switch
        {
            "identity" => evidence with { ExecutionIdentityDigest = ArticleBulkDigest.Of("foreign") },
            "plan" => evidence with { PlanDigest = ArticleBulkDigest.Of("foreign-plan") },
            "proof" => evidence with { GroupReceiptDigest = null },
            _ => evidence with
            {
                Outcome = ArticleBulkGroupCommitOutcome.UnknownRecovery,
                GroupReceiptDigest = null,
                ZeroWriteProofDigest = ArticleBulkDigest.Of("invented-zero")
            }
        };
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(evidence);
        Assert.Equal("article-bulk.group-recovery-unbound", (await Assert.ThrowsAsync<ArticleBulkContractException>(
            context.ResumeAsync)).Code);
        Assert.Null(await context.ReadAsync());
        Assert.Equal(context.Head.ContentDigest, (await context.OriginalAsync()).Head!.ContentDigest);
    }

    [Fact]
    public async Task LateUnknownEvidenceCreatesNoNewAttemptOrProof()
    {
        using Context context = await Context.CreateAsync();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            new ArticleBulkGroupRecoveryEvidence(context.Request.ExecutionIdentityDigest, context.Fixture.Plan.ContentDigest,
                ArticleBulkGroupCommitOutcome.UnknownRecovery, null, null, Stream([])));
        await context.ResumeAsync();
        Assert.Null(await context.ReadAsync());
        Assert.Null((await context.OriginalAsync()).TerminalReceipt!.ZeroWriteProofDigest);
    }

    [Fact]
    public async Task InterruptedExactReceiptStreamPersistsOnlyItsPrefixAndRestartCompletesTheSameObservation()
    {
        using Context context = await Context.CreateAsync(260);
        ArticleBulkItemReceipt[] canonical = context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed);
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, canonical.Take(250)));
        Assert.Equal("article-bulk.group-recovery-items-incomplete", (await Assert.ThrowsAsync<ArticleBulkContractException>(
            context.ResumeAsync)).Code);
        ArticleBulkReconciliationResult prefix = (await context.ReadAsync())!;
        Assert.Null(prefix.Receipt);
        Assert.Equal(250, prefix.Head.SucceededCount);
        Assert.False(prefix.Head.GroupCommitStarted);
        string[] prefixDigests = await context.ReceiptDigestsAsync(prefix.Head);
        Assert.Equal(context.Head.ContentDigest, (await context.OriginalAsync()).Head!.ContentDigest);
        context.Restart();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, canonical));
        await context.ResumeAsync();
        ArticleBulkReconciliationResult final = (await context.ReadAsync())!;
        Assert.Equal(prefix.Request.ContentDigest, final.Request.ContentDigest);
        Assert.Equal(260, final.Receipt!.SucceededCount);
        Assert.Equal(prefixDigests, (await context.ReceiptDigestsAsync(final.Head)).Take(250));
        Assert.Single(await context.EventsAsync(final.Head), static item => item.Kind == ArticleBulkJournalEventKind.GroupReconciled);
    }

    [Fact]
    public async Task ChangedCanonicalConclusionCannotRewriteAnAlreadySealedObservation()
    {
        using Context context = await Context.CreateAsync();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed)));
        await context.ResumeAsync();
        ArticleBulkReconciliationResult first = (await context.ReadAsync())!;
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.FailedZeroWrite, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.FailedZeroWrite)));
        Assert.Equal("article-bulk.group-recovery-unbound", (await Assert.ThrowsAsync<ArticleBulkContractException>(
            context.ResumeAsync)).Code);
        Assert.Equal(first.Head.ContentDigest, (await context.ReadAsync())!.Head.ContentDigest);
        Assert.Equal(context.Head.ContentDigest, (await context.OriginalAsync()).Head!.ContentDigest);
    }

    [Fact]
    public async Task SealedObservationRemainsReadableWhenLaterReadReturnsNoNewEvidence()
    {
        using Context context = await Context.CreateAsync();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed)));
        await context.ResumeAsync();
        ArticleBulkReconciliationResult first = (await context.ReadAsync())!;
        context.Fixture.Authority.GroupRecovery = null;
        context.Restart();
        await context.ResumeAsync();
        Assert.Equal(first.Receipt!.ContentDigest, (await context.ReadAsync())!.Receipt!.ContentDigest);
    }

    [Theory]
    [InlineData((int)ArticleBulkFileJournalCommitStage.EnvelopeDurable)]
    [InlineData((int)ArticleBulkFileJournalCommitStage.PointerSealed)]
    public async Task ObservationCreateCrashAndLostAcknowledgementResumeOneDeterministicJournal(int stageValue)
    {
        using Context context = await Context.CreateAsync();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed)));
        context.Restart(observer: (stage, _) => stage == (ArticleBulkFileJournalCommitStage)stageValue
            ? ValueTask.FromException(new IOException("injected-observation-create-fault")) : ValueTask.CompletedTask);
        await Assert.ThrowsAsync<IOException>(context.ResumeAsync);
        context.Restart();
        await context.ResumeAsync();
        ArticleBulkReconciliationResult recovered = (await context.ReadAsync())!;
        Assert.Equal(ArticleBulkExecutionState.Completed, recovered.Head.State);
        Assert.Equal(context.Head.ContentDigest, (await context.OriginalAsync()).Head!.ContentDigest);
        Assert.Single(await context.EventsAsync(recovered.Head), static item => item.Kind == ArticleBulkJournalEventKind.Planned);
        Assert.Single(await context.EventsAsync(recovered.Head), static item => item.Kind == ArticleBulkJournalEventKind.GroupReconciled);
    }

    [Fact]
    public async Task AuthorityRejectedKnownProofCannotCreateReconciliationStorage()
    {
        using Context context = await Context.CreateAsync();
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed)));
        context.Restart(authority: new RejectKnownAuthority(context.Fixture.Authority));
        Assert.Equal("test.known-proof-rejected", (await Assert.ThrowsAsync<ArticleBulkContractException>(context.ResumeAsync)).Code);
        context.Restart();
        Assert.Null(await context.ReadAsync());
        Assert.Equal(context.Head.ContentDigest, (await context.OriginalAsync()).Head!.ContentDigest);
    }

    [Fact]
    public async Task NormalCommandAttemptCannotAppendAReadOnlyReconciliationEvenWithAnOwnerProof()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        ArticleBulkAdmission admission = await ArticleBulkExecutorProtocol.AdmitAsync(fixture.Framework, fixture.Plan, fixture.Input, default);
        ArticleBulkJournalHead head = await ArticleBulkExecutorProtocol.StartAsync(fixture.Framework, fixture.Plan, admission.Head, default);
        (head, _) = await fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.RecoveryRequired,
            ArticleBulkExecutionState.RecoveryRequired, reasonCode: "test-unresolved");
        Assert.Equal("article-bulk.reconciliation-scope-unbound", (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.AppendAsync(head, fixture.Plan, ArticleBulkJournalEventKind.GroupReconciled, head.State,
                commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner,
                commandReceiptDigest: ArticleBulkDigest.Of("proof"), groupOutcome: ArticleBulkGroupCommitOutcome.Committed,
                groupReceiptDigest: ArticleBulkDigest.Of("proof")))).Code);
        Assert.DoesNotContain(fixture.Journal.Events, static item => item.Kind == ArticleBulkJournalEventKind.GroupReconciled);
    }

    [Fact]
    public async Task HistoricalPlanExpiryDoesNotTriggerNewSelectionPreflightOrBusinessAdmission()
    {
        using Context context = await Context.CreateAsync();
        int preflightCalls = context.Fixture.Preflight.Calls;
        context.Fixture.Authority.GroupRecovery = (_, _, _) => Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(
            context.Evidence(ArticleBulkGroupCommitOutcome.Committed, context.CanonicalReceipts(ArticleBulkGroupCommitOutcome.Committed)));
        context.Restart(time: new LaterTime(context.Fixture.Plan.ExpiresAtUtc.AddDays(1)));
        await context.ResumeAsync();
        Assert.Equal(ArticleBulkExecutionState.Completed, (await context.ReadAsync())!.Head.State);
        Assert.Equal(preflightCalls, context.Fixture.Preflight.Calls);
        Assert.Equal(1, context.Fixture.Selection.Calls);
    }

    private sealed class LaterTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class RejectKnownAuthority(ArticleBulkExecutorTestFixture.AuthorityDouble original) : IArticleBulkExecutionAuthority
    {
        public Task<ArticleBulkExecutionAuthoritySnapshot> ReadCurrentAsync(ArticleBulkPlan plan, CancellationToken cancellationToken)
            => original.ReadCurrentAsync(plan, cancellationToken);
        public Task<ArticleBulkGroupRecoveryEvidence?> ReadGroupRecoveryAsync(ArticleBulkExecutionRequest request,
            ArticleBulkPlan plan, ArticleBulkJournalHead checkpoint, CancellationToken cancellationToken)
            => original.ReadGroupRecoveryAsync(request, plan, checkpoint, cancellationToken);
        public Task ValidateGroupOutcomeAsync(ArticleBulkPlan plan, ArticleBulkGroupCommitOutcome outcome,
            string? groupReceiptDigest, string? zeroWriteProofDigest, CancellationToken cancellationToken)
            => outcome == ArticleBulkGroupCommitOutcome.UnknownRecovery ? Task.CompletedTask
                : Task.FromException(new ArticleBulkContractException("test.known-proof-rejected"));
    }

    private sealed class Context : IDisposable
    {
        private readonly string _directory = Path.Combine(Path.GetTempPath(), $"bulk-late-reconcile-{Guid.NewGuid():N}");
        internal ArticleBulkExecutorTestFixture Fixture { get; private init; } = null!;
        internal ArticleBulkFileJournalAuthority Journal { get; private set; } = null!;
        internal ArticleBulkExecutionFramework Framework { get; private set; } = null!;
        internal ArticleBulkExecutionRequest Request { get; private set; } = null!;
        internal ArticleBulkJournalHead Head { get; private set; } = null!;
        internal ArticleBulkAggregateReceipt OriginalReceipt { get; private set; } = null!;

        internal static async Task<Context> CreateAsync(int count = 3, bool started = true)
        {
            var context = new Context { Fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive", count) };
            Directory.CreateDirectory(context._directory);
            context.Restart();
            ArticleBulkAdmission admission = await ArticleBulkExecutorProtocol.AdmitAsync(context.Framework,
                context.Fixture.Plan, context.Fixture.Input, default);
            context.Request = admission.Request;
            context.Head = await ArticleBulkExecutorProtocol.StartAsync(context.Framework, context.Fixture.Plan,
                admission.Head, default);
            if (started)
            {
                (context.Head, _) = await context.Framework.AppendAsync(context.Head, context.Fixture.Plan,
                    ArticleBulkJournalEventKind.GroupCommitStarted, context.Head.State,
                    commandOwner: ArticleBulkOperationRegistry.Get(context.Fixture.Plan.OperationId).CommandOwner);
            }
            context.Head = await context.Framework.ResumeAsync(context.Request, context.Fixture.Plan, context.Head);
            context.OriginalReceipt = (await context.OriginalAsync()).TerminalReceipt!;
            return context;
        }

        internal void Restart(IArticleBulkExecutionAuthority? authority = null, TimeProvider? time = null,
            Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? observer = null)
        {
            Journal = new ArticleBulkFileJournalAuthority(new ArticleBulkFileJournalOptions(_directory,
                ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename), time ?? Fixture.Time, observer);
            Framework = new ArticleBulkExecutionFramework(Fixture.Planner, Journal, authority ?? Fixture.Authority, time ?? Fixture.Time);
        }

        internal Task<ArticleBulkJournalHead> ResumeAsync() => Framework.ResumeAsync(Request, Fixture.Plan, Head);
        internal Task<ArticleBulkReconciliationResult?> ReadAsync() => Framework.ReadReconciliationAsync(Request, Fixture.Plan, Head);
        internal Task<ArticleBulkIdempotencyResolution> OriginalAsync() => Journal.ResolveIdempotencyAsync(
            Request.IdempotencyKey, Request.ExecutionIdentityDigest, default);
        internal ArticleBulkItemReceipt[] CanonicalReceipts(ArticleBulkGroupCommitOutcome outcome) =>
            [.. Fixture.Plan.Items.Select(item => ArticleBulkExecutorTestFixture.ItemReceipt(Request, Fixture.Plan, item,
                outcome == ArticleBulkGroupCommitOutcome.Committed ? ArticleBulkItemStatus.Succeeded : ArticleBulkItemStatus.Failed))];
        internal ArticleBulkGroupRecoveryEvidence Evidence(ArticleBulkGroupCommitOutcome outcome, IEnumerable<ArticleBulkItemReceipt> items) =>
            new(Request.ExecutionIdentityDigest, Fixture.Plan.ContentDigest, outcome,
                outcome == ArticleBulkGroupCommitOutcome.Committed ? ArticleBulkDigest.Of("canonical-group") : null,
                outcome == ArticleBulkGroupCommitOutcome.Committed ? null : ArticleBulkDigest.Of("canonical-zero"), Stream(items));

        internal async Task<string[]> ReceiptDigestsAsync(ArticleBulkJournalHead head)
        {
            var result = new List<string>();
            await foreach (ArticleBulkItemReceipt receipt in Journal.ReadItemReceiptsAsync(head, default))
            {
                result.Add(receipt.ContentDigest);
            }
            return [.. result];
        }

        internal async Task<ArticleBulkJournalEvent[]> EventsAsync(ArticleBulkJournalHead head)
        {
            var result = new List<ArticleBulkJournalEvent>();
            await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in Journal.ReadEventBatchesAsync(head, 128, default))
            {
                result.AddRange(batch);
            }
            return [.. result];
        }

        public void Dispose() => Directory.Delete(_directory, recursive: true);
    }

    private static async IAsyncEnumerable<ArticleBulkItemReceipt> Stream(IEnumerable<ArticleBulkItemReceipt> items,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.CompletedTask;
        foreach (ArticleBulkItemReceipt item in items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return item;
        }
    }
}
