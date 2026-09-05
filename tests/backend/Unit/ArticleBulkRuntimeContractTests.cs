using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Services.Articles.Bulk;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkRuntimeContractTests(ITestOutputHelper output)
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-09-04T12:00:00Z");

    [Fact]
    public async Task AtomicPreflightFailureProducesTerminalZeroWriteReceipt()
    {
        string[] ids = ["article-1", "article-2"];
        var time = new MutableTimeProvider(s_now);
        var planAuthority = new ArticleBulkPlanAuthority(
            new DeterministicSelectionAuthority(ids),
            new DeterministicPreflightAuthority(blockedArticleId: "article-2"),
            time);
        ArticleBulkPlan plan = await planAuthority.CreateAsync(Request("lifecycle.archive", ids));
        var journal = new DeterministicJournalAuthority();
        var framework = new ArticleBulkExecutionFramework(planAuthority, journal, time);

        ArticleBulkAdmission admission = await framework.AdmitAsync(
            plan,
            "plan-store:blocked",
            "attempt-blocked",
            "idempotency-blocked",
            plan.Actor,
            plan.Source,
            plan.PolicyDigest,
            plan.PermissionPolicyDigest);

        Assert.Equal(ArticleBulkExecutionState.Blocked, admission.Head.State);
        Assert.NotNull(admission.ExistingTerminalReceipt);
        Assert.Equal(ArticleBulkGroupCommitOutcome.RejectedZeroWrite,
            admission.ExistingTerminalReceipt.GroupCommitOutcome);
        Assert.NotNull(admission.ExistingTerminalReceipt.ZeroWriteProofDigest);
        Assert.Equal(0, admission.ExistingTerminalReceipt.SucceededCount);
        await framework.VerifyExecutionAsync(admission.Request, plan, admission.Head);
    }

    [Fact]
    public async Task Executor_UsesCurrentTimeAndReturnsExactExistingAttempt()
    {
        var fixture = await RuntimeFixture.CreateAsync();
        ArticleBulkAdmission first = await fixture.Framework.AdmitAsync(
            fixture.Plan,
            "plan-store:one",
            "attempt-1",
            "idempotency-1",
            fixture.Plan.Actor,
            fixture.Plan.Source,
            fixture.Plan.PolicyDigest,
            fixture.Plan.PermissionPolicyDigest);
        ArticleBulkAdmission duplicate = await fixture.Framework.AdmitAsync(
            fixture.Plan,
            "plan-store:one",
            "attempt-2",
            "idempotency-1",
            fixture.Plan.Actor,
            fixture.Plan.Source,
            fixture.Plan.PolicyDigest,
            fixture.Plan.PermissionPolicyDigest);

        Assert.False(first.IsExisting);
        Assert.True(duplicate.IsExisting);
        Assert.Equal("attempt-1", duplicate.Request.AttemptId);
        Assert.Single(fixture.Journal.Events);

        fixture.Time.UtcNow = fixture.Plan.ExpiresAtUtc;
        ArticleBulkContractException expired = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.AdmitAsync(
                fixture.Plan,
                "plan-store:one",
                "attempt-3",
                "idempotency-2",
                fixture.Plan.Actor,
                fixture.Plan.Source,
                fixture.Plan.PolicyDigest,
                fixture.Plan.PermissionPolicyDigest));
        Assert.Equal("article-bulk.plan-expired", expired.Code);
    }

    [Fact]
    public async Task ExecutorRejectsPolicyAndSelectionDriftBeforeJournalCreation()
    {
        string[] ids = ["article-1", "article-2"];
        var time = new MutableTimeProvider(s_now);
        var selection = new DeterministicSelectionAuthority(ids);
        var planAuthority = new ArticleBulkPlanAuthority(
            selection,
            new DeterministicPreflightAuthority(),
            time);
        ArticleBulkPlan plan = await planAuthority.CreateAsync(Request(
            "category.add",
            ids,
            ArticleBulkSelectionKind.Query));
        var journal = new DeterministicJournalAuthority();
        var framework = new ArticleBulkExecutionFramework(planAuthority, journal, time);

        Assert.Equal("article-bulk.execution-drift",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() => framework.AdmitAsync(
                plan,
                "plan-store:drift",
                "attempt-policy-drift",
                "idempotency-policy-drift",
                plan.Actor,
                plan.Source,
                Digest("changed-policy"),
                plan.PermissionPolicyDigest))).Code);

        selection.ResolvedIds = ["article-1", "article-3"];
        Assert.Equal("article-bulk.plan-drift",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() => framework.AdmitAsync(
                plan,
                "plan-store:drift",
                "attempt-selection-drift",
                "idempotency-selection-drift",
                plan.Actor,
                plan.Source,
                plan.PolicyDigest,
                plan.PermissionPolicyDigest))).Code);
        Assert.Empty(journal.Events);
    }

    [Fact]
    public async Task JournalAuthority_RejectsOverwriteCasCompetitionAndCrashBeforeHead()
    {
        var fixture = await RuntimeFixture.CreateAsync();
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        (ArticleBulkJournalHead admitted, _) = await fixture.Framework.AppendAsync(
            admission.Head,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted);

        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.AppendAsync(
            admission.Head,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted));

        fixture.Journal.CrashAfterProvisionalEvent = true;
        await Assert.ThrowsAsync<InjectedJournalCrashException>(() => fixture.Framework.AppendAsync(
            admitted,
            ArticleBulkJournalEventKind.ExecutionStarted,
            ArticleBulkExecutionState.Executing));
        Assert.Equal(2, fixture.Journal.Events.Count);
        Assert.Equal(admitted.ContentDigest, fixture.Journal.Head!.ContentDigest);

        (ArticleBulkJournalHead executing, _) = await fixture.Framework.AppendAsync(
            admitted,
            ArticleBulkJournalEventKind.ExecutionStarted,
            ArticleBulkExecutionState.Executing);
        (ArticleBulkJournalHead itemAdmitted, _) = await fixture.Framework.AppendAsync(
            executing,
            ArticleBulkJournalEventKind.ItemAdmitted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (ArticleBulkJournalHead itemStarted, _) = await fixture.Framework.AppendAsync(
            itemAdmitted,
            ArticleBulkJournalEventKind.ItemStarted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);
        ArticleBulkItemReceipt itemReceipt = fixture.SuccessReceipt("article-00000");
        ArticleBulkContractException unboundCommand = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.AppendAsync(
                itemStarted,
                ArticleBulkJournalEventKind.ItemTerminal,
                ArticleBulkExecutionState.Executing,
                articleId: "article-00000",
                commandOwner: "not-the-canonical-owner",
                commandReceiptDigest: itemReceipt.CanonicalCommandReceiptDigest,
                itemReceipt: itemReceipt,
                reasonCode: "succeeded",
                expectedItemStatus: ArticleBulkItemStatus.Executing,
                nextItemStatus: ArticleBulkItemStatus.Succeeded));
        Assert.Equal("article-bulk.item-journal-binding-invalid", unboundCommand.Code);
        (ArticleBulkJournalHead itemTerminal, _) = await fixture.Framework.AppendAsync(
            itemStarted,
            ArticleBulkJournalEventKind.ItemTerminal,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            commandOwner: itemReceipt.CanonicalCommandOwner,
            commandReceiptDigest: itemReceipt.CanonicalCommandReceiptDigest,
            itemReceipt: itemReceipt,
            reasonCode: "succeeded",
            expectedItemStatus: ArticleBulkItemStatus.Executing,
            nextItemStatus: ArticleBulkItemStatus.Succeeded);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.AppendAsync(
            itemTerminal,
            ArticleBulkJournalEventKind.ItemStarted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing));

        await fixture.Framework.VerifyJournalAsync(itemTerminal);
        ArticleBulkJournalEvent original = fixture.Journal.Events[1];
        fixture.Journal.Events[1] = original with
        {
            ReasonCode = "tampered-without-resealing"
        };
        Assert.Equal("article-bulk.journal-tampered",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
                fixture.Framework.VerifyJournalAsync(itemTerminal))).Code);
        fixture.Journal.Events[1] = original;
    }

    [Theory]
    [InlineData(2, 0, 5)]
    [InlineData(1, 1, 6)]
    [InlineData(0, 2, 7)]
    public async Task PerItemTerminalOutcomesRemainExact(
        int succeeded,
        int failed,
        int terminalStateValue)
    {
        var terminalState = (ArticleBulkExecutionState)terminalStateValue;
        var fixture = await RuntimeFixture.CreateAsync(itemCount: 2);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        for (int index = 0; index < 2; index++)
        {
            head = await fixture.RecordTerminalItemAsync(
                head,
                $"article-{index:D5}",
                succeeded: index < succeeded);
        }
        ArticleBulkAggregateReceipt aggregate = fixture.Aggregate(terminalState, succeeded, failed);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            terminalState,
            aggregateReceipt: aggregate,
            reasonCode: terminalState.ToString().ToLowerInvariant());

        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head);

        Assert.Equal(succeeded, head.SucceededCount);
        Assert.Equal(failed, head.FailedCount);
    }

    [Fact]
    public async Task ResumeUsesSealedJournalAndMarksUnknownActiveOutcomeForRecovery()
    {
        var fixture = await RuntimeFixture.CreateAsync(itemCount: 2);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ItemAdmitted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ItemStarted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);

        ArticleBulkJournalHead resumed = await fixture.Framework.ResumeAsync(
            fixture.Journal.Request!,
            fixture.Plan,
            head);

        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, resumed.State);
        Assert.Equal(ArticleBulkJournalEventKind.ExecutionTerminal, fixture.Journal.Events[^1].Kind);
        Assert.Equal(ArticleBulkItemStatus.RecoveryRequired,
            fixture.Journal.ItemReceipts["article-00000"].ExecutionStatus);
        Assert.Equal(ArticleBulkItemStatus.Cancelled,
            fixture.Journal.ItemReceipts["article-00001"].ExecutionStatus);
        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, resumed);

        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(
            fixture.Journal.Request!,
            fixture.Plan,
            resumed,
            "attempt-recovery-retry",
            new Dictionary<string, string> { ["article-00000"] = "revision-recovered" });
        Assert.Equal("article-00000", Assert.Single(retry.Request.FailedItems).ArticleId);
    }

    [Fact]
    public async Task ResumeMarksUnknownAtomicGroupAndEveryItemForRecovery()
    {
        var fixture = await RuntimeFixture.CreateAsync(operationId: "lifecycle.archive", itemCount: 2);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.GroupCommitStarted,
            ArticleBulkExecutionState.Executing);

        ArticleBulkJournalHead resumed = await fixture.Framework.ResumeAsync(
            fixture.Journal.Request!,
            fixture.Plan,
            head);

        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, resumed.State);
        Assert.True(resumed.GroupCommitTerminal);
        Assert.Equal(2, resumed.FailedCount);
        Assert.All(fixture.Journal.ItemReceipts.Values,
            static receipt => Assert.Equal(ArticleBulkItemStatus.RecoveryRequired, receipt.ExecutionStatus));
        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, resumed);
    }

    [Fact]
    public async Task CancellationAndAtomicCommitBoundariesAreStrategyAware()
    {
        var perItem = await RuntimeFixture.CreateAsync();
        ArticleBulkJournalHead executing = await perItem.StartExecutingAsync();
        (ArticleBulkJournalHead admittedItem, _) = await perItem.Framework.AppendAsync(
            executing,
            ArticleBulkJournalEventKind.ItemAdmitted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (ArticleBulkJournalHead started, _) = await perItem.Framework.AppendAsync(
            admittedItem,
            ArticleBulkJournalEventKind.ItemStarted,
            ArticleBulkExecutionState.Executing,
            articleId: "article-00000",
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);
        (ArticleBulkJournalHead cancelling, _) = await perItem.Framework.AppendAsync(
            started,
            ArticleBulkJournalEventKind.CancelRequested,
            ArticleBulkExecutionState.Cancelling,
            reasonCode: "user-requested");
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => perItem.Framework.AppendAsync(
            cancelling,
            ArticleBulkJournalEventKind.ItemAdmitted,
            ArticleBulkExecutionState.Cancelling,
            articleId: "article-new"));
        Assert.Contains("article-00000", cancelling.ActiveArticleIds);
        ArticleBulkJournalHead cancelledActive = await perItem.Framework.ResumeAsync(
            perItem.Journal.Request!,
            perItem.Plan,
            cancelling);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, cancelledActive.State);
        await perItem.Framework.VerifyExecutionAsync(
            perItem.Journal.Request!,
            perItem.Plan,
            cancelledActive);

        var atomic = await RuntimeFixture.CreateAsync(operationId: "lifecycle.archive");
        ArticleBulkJournalHead atomicExecuting = await atomic.StartExecutingAsync();
        (ArticleBulkJournalHead commitStarted, _) = await atomic.Framework.AppendAsync(
            atomicExecuting,
            ArticleBulkJournalEventKind.GroupCommitStarted,
            ArticleBulkExecutionState.Executing);
        ArticleBulkContractException tooLate = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            atomic.Framework.AppendAsync(
                commitStarted,
                ArticleBulkJournalEventKind.CancelRequested,
                ArticleBulkExecutionState.Cancelling));
        Assert.Equal("article-bulk.cancel-too-late", tooLate.Code);

        var beforeCommit = await RuntimeFixture.CreateAsync(operationId: "lifecycle.archive", itemCount: 2);
        ArticleBulkJournalHead cancellable = await beforeCommit.StartExecutingAsync();
        (cancellable, _) = await beforeCommit.Framework.AppendAsync(
            cancellable,
            ArticleBulkJournalEventKind.CancelRequested,
            ArticleBulkExecutionState.Cancelling,
            reasonCode: "user-requested");
        cancellable = await beforeCommit.Framework.ResumeAsync(
            beforeCommit.Journal.Request!,
            beforeCommit.Plan,
            cancellable);
        await beforeCommit.Framework.VerifyExecutionAsync(
            beforeCommit.Journal.Request!,
            beforeCommit.Plan,
            cancellable);
        Assert.Equal(ArticleBulkExecutionState.Cancelled, cancellable.State);
        Assert.All(beforeCommit.Journal.ItemReceipts.Values,
            static receipt => Assert.Equal(ArticleBulkItemStatus.Cancelled, receipt.ExecutionStatus));
        Assert.Equal(2, beforeCommit.Journal.ItemReceipts.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AtomicGroupProducesSingleOutcomeAndAuditableItemReceipts(bool commitSucceeds)
    {
        var fixture = await RuntimeFixture.CreateAsync(operationId: "lifecycle.archive", itemCount: 2);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.GroupCommitStarted,
            ArticleBulkExecutionState.Executing);
        ArticleBulkGroupCommitOutcome outcome = commitSucceeds
            ? ArticleBulkGroupCommitOutcome.Committed
            : ArticleBulkGroupCommitOutcome.FailedZeroWrite;
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.GroupCommitTerminal,
            ArticleBulkExecutionState.Executing,
            groupOutcome: outcome,
            groupReceiptDigest: commitSucceeds ? Digest("group-commit") : null,
            zeroWriteProofDigest: commitSucceeds ? null : Digest("zero-write"));
        ArticleBulkItemReceipt[] receipts =
        [
            fixture.Receipt("article-00000", commitSucceeds),
            fixture.Receipt("article-00001", commitSucceeds)
        ];
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ReceiptChunkRecorded,
            ArticleBulkExecutionState.Executing,
            receiptChunk: receipts,
            reasonCode: "group-item-receipts");
        ArticleBulkExecutionState terminalState = commitSucceeds
            ? ArticleBulkExecutionState.Completed
            : ArticleBulkExecutionState.Failed;
        ArticleBulkAggregateReceipt aggregate = fixture.Aggregate(
            terminalState,
            succeeded: commitSucceeds ? 2 : 0,
            failed: commitSucceeds ? 0 : 2,
            groupOutcome: outcome,
            groupReceiptDigest: commitSucceeds ? Digest("group-commit") : null,
            zeroWriteProofDigest: commitSucceeds ? null : Digest("zero-write"));
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            terminalState,
            groupOutcome: outcome,
            groupReceiptDigest: aggregate.GroupReceiptDigest,
            zeroWriteProofDigest: aggregate.ZeroWriteProofDigest,
            aggregateReceipt: aggregate,
            reasonCode: commitSucceeds ? "completed" : "group-commit-failed");

        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head);
        Assert.Equal(commitSucceeds ? 2 : 0, head.SucceededCount);
        Assert.Equal(commitSucceeds ? 0 : 2, head.FailedCount);
    }

    [Fact]
    public async Task RetryConsumesSealedJournalAndIncludesFailedItemsOnly()
    {
        var fixture = await RuntimeFixture.CreateAsync(itemCount: 2);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        head = await fixture.RecordTerminalItemAsync(head, "article-00000", succeeded: true);
        head = await fixture.RecordTerminalItemAsync(head, "article-00001", succeeded: false);
        ArticleBulkAggregateReceipt aggregate = fixture.Aggregate(
            ArticleBulkExecutionState.Partial,
            succeeded: 1,
            failed: 1);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            ArticleBulkExecutionState.Partial,
            aggregateReceipt: aggregate,
            reasonCode: "partial");

        ArticleBulkRetryAdmission retry = await fixture.Framework.CreateRetryAsync(
            fixture.Journal.Request!,
            fixture.Plan,
            head,
            "attempt-retry",
            new Dictionary<string, string> { ["article-00001"] = "revision-new" });

        Assert.Equal("article-00001", Assert.Single(retry.Request.FailedItems).ArticleId);
        Assert.Equal(ArticleBulkJournalEventKind.RetryRequested, fixture.Journal.Events[^1].Kind);
        await Assert.ThrowsAsync<ArticleBulkContractException>(() => fixture.Framework.CreateRetryAsync(
            fixture.Journal.Request!,
            fixture.Plan,
            retry.Head,
            "attempt-expanded",
            new Dictionary<string, string>
            {
                ["article-00000"] = "revision-new",
                ["article-00001"] = "revision-new"
            }));
    }

    [Fact]
    public async Task TerminalReceiptIsBoundToExistingRequestPlanAndExactItemReceipts()
    {
        var fixture = await RuntimeFixture.CreateAsync(itemCount: 1);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        head = await fixture.RecordTerminalItemAsync(head, "article-00000", succeeded: true);
        ArticleBulkAggregateReceipt aggregate = fixture.Aggregate(
            ArticleBulkExecutionState.Completed,
            succeeded: 1,
            failed: 0);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            ArticleBulkExecutionState.Completed,
            aggregateReceipt: aggregate,
            reasonCode: "completed");

        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head);

        ArticleBulkAggregateReceipt summaryOnly = aggregate with
        {
            ItemReceiptChunks = [],
            ContentDigest = string.Empty
        };
        fixture.Journal.TerminalReceipt = summaryOnly with
        {
            ContentDigest = ArticleBulkDigest.Of(summaryOnly)
        };
        Assert.Equal("article-bulk.aggregate-receipt-inexact",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
                fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head))).Code);

        ArticleBulkAggregateReceipt tampered = aggregate with
        {
            PlanDigest = Digest("different-plan"),
            ContentDigest = string.Empty
        };
        fixture.Journal.TerminalReceipt = tampered with
        {
            ContentDigest = ArticleBulkDigest.Of(tampered)
        };
        ArticleBulkContractException error = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head));
        Assert.Equal("article-bulk.terminal-receipt-tampered", error.Code);
    }

    [Fact]
    public void StaticGovernanceKeepsOneJournalAndRejectsHiddenDiscoveryOrRetry()
    {
        string bulkRoot = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "backend",
            "Services",
            "Articles",
            "Bulk");
        string[] sources = Directory.GetFiles(bulkRoot, "*.cs", SearchOption.TopDirectoryOnly);
        string combined = string.Join('\n', sources.Select(File.ReadAllText));
        string executionSource = File.ReadAllText(Path.Combine(bulkRoot, "ArticleBulkExecutionFramework.cs"));

        Assert.Single(Regex.Matches(combined, @"\binterface\s+IArticleBulkJournalAuthority\b"));
        Assert.Single(Regex.Matches(combined, @"\bclass\s+ArticleBulkExecutionFramework\b"));
        Assert.Single(Regex.Matches(combined, @"\bclass\s+ArticleBulkOperationRegistry\b"));
        Assert.Single(Regex.Matches(combined, @"\bclass\s+ArticleBulkPlanAuthority\b"));
        Assert.DoesNotContain("Directory.GetFiles(", executionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("GetLastWriteTime", executionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.Delay(", executionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("Polly", executionSource, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TenThousandItemJournalStreamsWithBoundedRetainedMemory()
    {
        var fixture = await RuntimeFixture.CreateAsync(itemCount: 10_000);
        ArticleBulkJournalHead head = await fixture.StartExecutingAsync();
        for (int index = 0; index < 10_000; index++)
        {
            head = await fixture.RecordTerminalItemAsync(head, $"article-{index:D5}", succeeded: true);
        }
        ArticleBulkAggregateReceipt aggregate = fixture.Aggregate(
            ArticleBulkExecutionState.Completed,
            succeeded: 10_000,
            failed: 0);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            ArticleBulkExecutionState.Completed,
            aggregateReceipt: aggregate,
            reasonCode: "completed");

        long before = GC.GetTotalMemory(forceFullCollection: true);
        await fixture.Framework.VerifyExecutionAsync(fixture.Journal.Request!, fixture.Plan, head);
        long retainedBytes = GC.GetTotalMemory(forceFullCollection: true) - before;
        output.WriteLine(
            $"events={head.EventCount}; receiptChunks={aggregate.ItemReceiptChunks.Length}; "
            + $"maxReadBatch={fixture.Journal.MaximumObservedReadBatch}; retainedBytes={retainedBytes}");

        Assert.Equal(30_004, head.EventCount);
        Assert.Equal(40, aggregate.ItemReceiptChunks.Length);
        Assert.True(retainedBytes <= 16 * 1024 * 1024, $"retained bytes: {retainedBytes}");
        Assert.InRange(
            fixture.Journal.MaximumObservedReadBatch,
            1,
            ArticleBulkExecutionFramework.JournalReadBatchSize);
    }

    private static ArticleBulkPlanRequest Request(
        string operationId,
        IReadOnlyList<string> ids,
        ArticleBulkSelectionKind selectionKind = ArticleBulkSelectionKind.Explicit) => new(
        operationId,
        operationId == "category.add"
            ? Parameters(("categoryId", "category-1"))
            : Parameters(("reasonCode", "bulk-request")),
        new ArticleBulkSelection(
            selectionKind,
            selectionKind is ArticleBulkSelectionKind.Explicit or ArticleBulkSelectionKind.CurrentPage
                ? [.. ids]
                : [],
            selectionKind is ArticleBulkSelectionKind.SavedView or ArticleBulkSelectionKind.Query
                ? "selection-authority-1"
                : null,
            Digest("selection")),
        new ArticleBulkActor("user-1", "site-1", Digest("actor")),
        new ArticleBulkSource(new string('a', 40), Digest("build")),
        Digest("policy"),
        Digest("permission-policy"),
        s_now,
        s_now.AddMinutes(30));

    private static Dictionary<string, JsonElement> Parameters(params (string Name, string Value)[] pairs) =>
        pairs.ToDictionary(
            static pair => pair.Name,
            static pair => JsonSerializer.SerializeToElement(pair.Value),
            StringComparer.Ordinal);

    private static string Digest(string seed) =>
        ArticleBulkDigest.Of(seed);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        internal DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class DeterministicSelectionAuthority(IEnumerable<string> ids) : IArticleBulkSelectionAuthority
    {
        internal IReadOnlyList<string> ResolvedIds { get; set; } = [.. ids];
        internal int ResolveCalls
        {
            get; private set;
        }

        public Task<ArticleBulkSelectionResolution> ResolveAsync(
            ArticleBulkSelection selection,
            ArticleBulkActor actor,
            CancellationToken cancellationToken)
        {
            ResolveCalls++;
            return Task.FromResult(new ArticleBulkSelectionResolution(
                Digest("selection-authority"),
                Digest(string.Join(',', ResolvedIds)),
                Stream(ResolvedIds, cancellationToken)));
        }
    }

    private sealed class DeterministicPreflightAuthority(string? blockedArticleId = null) : IArticleBulkPreflightAuthority
    {
        internal int ObservedCount
        {
            get; private set;
        }

        public async IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
            IReadOnlyList<string> orderedArticleIds,
            ArticleBulkOperation operation,
            IReadOnlyDictionary<string, object> normalizedParameters,
            ArticleBulkActor actor,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (string articleId in orderedArticleIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ObservedCount++;
                bool blocked = articleId == blockedArticleId;
                yield return new ArticleBulkArticleObservation(
                    articleId,
                    Exists: true,
                    SiteId: blocked ? "another-site" : actor.SiteId,
                    Revision: $"revision-{articleId}",
                    Lifecycle: operation.Id == "lifecycle.archive" ? "draft" : "inbox",
                    Permitted: !blocked,
                    Applicable: true,
                    PermissionDigest: Digest($"permission-{articleId}"),
                    StateDigest: Digest($"state-{articleId}"),
                    DependencyDigests: [Digest($"dependency-{articleId}")]);
                await Task.Yield();
            }
        }
    }

    private static async IAsyncEnumerable<string> Stream(
        IEnumerable<string> values,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (string value in values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return value;
            await Task.Yield();
        }
    }

    private sealed class RuntimeFixture(
        ArticleBulkPlan plan,
        MutableTimeProvider time,
        DeterministicJournalAuthority journal,
        ArticleBulkExecutionFramework framework)
    {
        internal ArticleBulkPlan Plan { get; } = plan;
        internal MutableTimeProvider Time { get; } = time;
        internal DeterministicJournalAuthority Journal { get; } = journal;
        internal ArticleBulkExecutionFramework Framework { get; } = framework;

        internal static async Task<RuntimeFixture> CreateAsync(string operationId = "category.add", int itemCount = 1)
        {
            string[] ids = [.. Enumerable.Range(0, itemCount).Select(static index => $"article-{index:D5}")];
            var time = new MutableTimeProvider(s_now);
            var planAuthority = new ArticleBulkPlanAuthority(
                new DeterministicSelectionAuthority(ids),
                new DeterministicPreflightAuthority(),
                time);
            ArticleBulkPlan plan = await planAuthority.CreateAsync(Request(operationId, ids));
            var journal = new DeterministicJournalAuthority();
            return new RuntimeFixture(plan, time, journal, new ArticleBulkExecutionFramework(planAuthority, journal, time));
        }

        internal Task<ArticleBulkAdmission> AdmitAsync() => Framework.AdmitAsync(
            Plan,
            "plan-store:one",
            "attempt-1",
            "idempotency-1",
            Plan.Actor,
            Plan.Source,
            Plan.PolicyDigest,
            Plan.PermissionPolicyDigest);

        internal async Task<ArticleBulkJournalHead> StartExecutingAsync()
        {
            ArticleBulkAdmission admission = await AdmitAsync();
            (ArticleBulkJournalHead admitted, _) = await Framework.AppendAsync(
                admission.Head,
                ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted);
            (ArticleBulkJournalHead executing, _) = await Framework.AppendAsync(
                admitted,
                ArticleBulkJournalEventKind.ExecutionStarted,
                ArticleBulkExecutionState.Executing);
            return executing;
        }

        internal ArticleBulkItemReceipt SuccessReceipt(string articleId) => Receipt(articleId, true);

        internal ArticleBulkItemReceipt Receipt(string articleId, bool succeeded)
        {
            ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(Plan.OperationId);
            var unsigned = new ArticleBulkItemReceipt(
                "attempt-1",
                Plan.ContentDigest,
                Plan.RegistryDigest,
                Plan.OperationId,
                articleId,
                $"revision-{articleId}",
                $"revision-{articleId}",
                succeeded ? $"revision-new-{articleId}" : null,
                ArticleBulkPlanItemStatus.Eligible,
                succeeded ? ArticleBulkItemStatus.Succeeded : ArticleBulkItemStatus.Failed,
                succeeded ? "succeeded" : "command-failed",
                operation.CommandOwner,
                Digest($"command-{articleId}"),
                succeeded
                    ? [.. operation.SideEffectOwners.Select(owner => new ArticleBulkSideEffectReceipt(
                        owner,
                        Digest($"{owner}-{articleId}")))]
                    : [],
                Digest($"retry-{articleId}"),
                string.Empty);
            return ArticleBulkExecutionFramework.SealItemReceipt(unsigned);
        }

        internal async Task<ArticleBulkJournalHead> RecordTerminalItemAsync(
            ArticleBulkJournalHead head,
            string articleId,
            bool succeeded)
        {
            (head, _) = await Framework.AppendAsync(
                head,
                ArticleBulkJournalEventKind.ItemAdmitted,
                ArticleBulkExecutionState.Executing,
                articleId: articleId,
                nextItemStatus: ArticleBulkItemStatus.Admitted);
            (head, _) = await Framework.AppendAsync(
                head,
                ArticleBulkJournalEventKind.ItemStarted,
                ArticleBulkExecutionState.Executing,
                articleId: articleId,
                expectedItemStatus: ArticleBulkItemStatus.Admitted,
                nextItemStatus: ArticleBulkItemStatus.Executing);
            ArticleBulkItemReceipt receipt = Receipt(articleId, succeeded);
            (head, _) = await Framework.AppendAsync(
                head,
                ArticleBulkJournalEventKind.ItemTerminal,
                ArticleBulkExecutionState.Executing,
                articleId: articleId,
                commandOwner: receipt.CanonicalCommandOwner,
                commandReceiptDigest: receipt.CanonicalCommandReceiptDigest,
                itemReceipt: receipt,
                reasonCode: succeeded ? "succeeded" : "command-failed",
                expectedItemStatus: ArticleBulkItemStatus.Executing,
                nextItemStatus: receipt.ExecutionStatus);
            return head;
        }

        internal ArticleBulkAggregateReceipt Aggregate(
            ArticleBulkExecutionState state,
            int succeeded,
            int failed,
            ArticleBulkGroupCommitOutcome? groupOutcome = null,
            string? groupReceiptDigest = null,
            string? zeroWriteProofDigest = null)
        {
            ImmutableArray<string> itemDigests = [.. Journal.ItemReceipts.Values.Select(static receipt => receipt.ContentDigest)];
            var chunks = ImmutableArray.CreateBuilder<ArticleBulkReceiptChunk>();
            for (int offset = 0; offset < itemDigests.Length; offset += ArticleBulkExecutionFramework.ReceiptChunkSize)
            {
                ImmutableArray<string> slice = itemDigests
                    .Skip(offset)
                    .Take(ArticleBulkExecutionFramework.ReceiptChunkSize)
                    .ToImmutableArray();
                var chunk = new ArticleBulkReceiptChunk(chunks.Count, slice, string.Empty);
                chunks.Add(chunk with
                {
                    ContentDigest = ArticleBulkDigest.Of(chunk)
                });
            }
            var unsigned = new ArticleBulkAggregateReceipt(
                "attempt-1",
                Journal.Request!.ContentDigest,
                Plan.ContentDigest,
                Plan.RegistryDigest,
                Plan.OperationId,
                Plan.Strategy,
                Plan.FrozenSetDigest,
                Plan.Impact.SelectedCount,
                Plan.Impact.EligibleCount,
                succeeded,
                failed,
                0,
                state,
                groupOutcome,
                groupReceiptDigest,
                zeroWriteProofDigest,
                state == ArticleBulkExecutionState.Partial,
                Plan.Strategy == ArticleBulkExecutionStrategy.PerItemIsolated && failed > 0,
                chunks.ToImmutable(),
                string.Empty);
            return ArticleBulkExecutionFramework.SealAggregateReceipt(unsigned);
        }
    }

    private sealed class DeterministicJournalAuthority : IArticleBulkJournalAuthority
    {
        private readonly Dictionary<string, ArticleBulkItemStatus> _itemStates = new(StringComparer.Ordinal);
        internal List<ArticleBulkJournalEvent> Events { get; } = [];
        internal Dictionary<string, ArticleBulkItemReceipt> ItemReceipts { get; } = new(StringComparer.Ordinal);
        internal ArticleBulkExecutionRequest? Request
        {
            get; private set;
        }
        internal ArticleBulkJournalHead? Head
        {
            get; private set;
        }
        internal ArticleBulkAggregateReceipt? TerminalReceipt
        {
            get; set;
        }
        internal string? IdempotencyKey
        {
            get; private set;
        }
        internal bool CrashAfterProvisionalEvent
        {
            get; set;
        }
        internal int MaximumObservedReadBatch
        {
            get; private set;
        }

        public Task<ArticleBulkIdempotencyResolution> ResolveIdempotencyAsync(
            string idempotencyKey,
            string executionIdentityDigest,
            CancellationToken cancellationToken)
        {
            if (IdempotencyKey is null)
            {
                return Task.FromResult(new ArticleBulkIdempotencyResolution(
                    ArticleBulkIdempotencyKind.Missing, null, null, null));
            }
            if (IdempotencyKey != idempotencyKey || Head!.ExecutionIdentityDigest != executionIdentityDigest)
            {
                return Task.FromResult(new ArticleBulkIdempotencyResolution(
                    ArticleBulkIdempotencyKind.Conflict, Request, Head, TerminalReceipt));
            }
            return Task.FromResult(new ArticleBulkIdempotencyResolution(
                TerminalReceipt is null ? ArticleBulkIdempotencyKind.InProgress : ArticleBulkIdempotencyKind.Terminal,
                Request,
                Head,
                TerminalReceipt));
        }

        public Task<ArticleBulkJournalAppendReceipt> CreateAsync(
            string idempotencyKey,
            ArticleBulkExecutionRequest request,
            ArticleBulkJournalEvent firstEvent,
            ArticleBulkJournalHead firstHead,
            CancellationToken cancellationToken)
        {
            if (Head is not null)
            {
                throw new ArticleBulkContractException("article-bulk.idempotency-conflict");
            }
            IdempotencyKey = idempotencyKey;
            Request = request;
            Events.Add(firstEvent);
            Head = firstHead;
            return Task.FromResult(AppendReceipt(firstEvent, firstHead));
        }

        public Task<ArticleBulkJournalAppendReceipt> AppendAsync(
            ArticleBulkJournalAppend append,
            CancellationToken cancellationToken)
        {
            if (Head is null || Head.ContentDigest != append.ExpectedHeadDigest)
            {
                throw new ArticleBulkContractException("article-bulk.journal-cas-conflict");
            }
            if (append.ArticleId is not null && append.ExpectedItemStatus is not null
                && (!_itemStates.TryGetValue(append.ArticleId, out ArticleBulkItemStatus actual)
                    || actual != append.ExpectedItemStatus))
            {
                throw new ArticleBulkContractException("article-bulk.item-cas-conflict");
            }
            if (append.ArticleId is not null && append.ExpectedItemStatus is null
                && append.NextItemStatus is not null && _itemStates.ContainsKey(append.ArticleId))
            {
                throw new ArticleBulkContractException("article-bulk.item-overwrite");
            }
            if (CrashAfterProvisionalEvent)
            {
                CrashAfterProvisionalEvent = false;
                Events.Add(append.Event);
                Events.RemoveAt(Events.Count - 1);
                throw new InjectedJournalCrashException();
            }
            if (append.ItemReceipts.Any(receipt => ItemReceipts.ContainsKey(receipt.ArticleId)))
            {
                throw new ArticleBulkContractException("article-bulk.item-overwrite");
            }

            // Deterministic simulation of the production port's required all-or-nothing commit.
            Events.Add(append.Event);
            Head = append.NextHead;
            if (append.ArticleId is not null && append.NextItemStatus is not null)
            {
                _itemStates[append.ArticleId] = append.NextItemStatus.Value;
            }
            foreach (ArticleBulkItemReceipt itemReceipt in append.ItemReceipts)
            {
                ItemReceipts.Add(itemReceipt.ArticleId, itemReceipt);
            }
            TerminalReceipt = append.AggregateReceipt ?? TerminalReceipt;
            return Task.FromResult(AppendReceipt(append.Event, append.NextHead));
        }

        public async IAsyncEnumerable<IReadOnlyList<ArticleBulkJournalEvent>> ReadEventBatchesAsync(
            string attemptId,
            int maximumBatchSize,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            for (int index = 0; index < Events.Count; index += maximumBatchSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ArticleBulkJournalEvent[] batch = [.. Events.Skip(index).Take(maximumBatchSize)];
                MaximumObservedReadBatch = Math.Max(MaximumObservedReadBatch, batch.Length);
                yield return batch;
                await Task.Yield();
            }
        }

        public async IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
            string attemptId,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (ArticleBulkItemReceipt receipt in ItemReceipts.Values)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return receipt;
                await Task.Yield();
            }
        }

        private static ArticleBulkJournalAppendReceipt AppendReceipt(
            ArticleBulkJournalEvent journalEvent,
            ArticleBulkJournalHead head) => new(
                journalEvent.AttemptId,
                journalEvent.Ordinal,
                journalEvent.ContentDigest,
                head.ContentDigest,
                Digest($"authority-{journalEvent.Ordinal}"));
    }

    private sealed class InjectedJournalCrashException : Exception;
}
