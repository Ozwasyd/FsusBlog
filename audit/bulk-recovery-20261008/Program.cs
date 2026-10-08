using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Tests.Unit;

// Pure protocol diagnostics: original owner plan inputs, actual production framework/executors
// and fsync file journal. No audit-generated business success, commit, rollback or side-effect
// receipt is supplied. These diagnostics cannot qualify a canonical DB adapter or product flow.
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Choose prepare-resume, unknown-retry, concurrent-unknown, journal-cut, journal-ack, or cancel-retry.");
            return 2;
        }
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-bulk-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            return args[0] switch
            {
                "prepare-resume" => await PrepareResumeAsync(directory),
                "unknown-retry" => await UnknownRetryAsync(directory),
                "concurrent-unknown" => await ConcurrentUnknownAsync(directory),
                "journal-cut" => await JournalCutAsync(directory),
                "journal-ack" => await JournalAckAsync(directory),
                "cancel-retry" => await CancelRetryAsync(directory),
                "group-terminal-cut" => await GroupTerminalCutAsync(directory),
                "partial-group-proof" => await PartialGroupProofAsync(directory),
                _ => 2
            };
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static ArticleBulkFileJournalAuthority Journal(
        string directory,
        ArticleBulkExecutorTestFixture fixture,
        Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? observer = null)
        => new(new ArticleBulkFileJournalOptions(
            directory, ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename), fixture.Time, observer);

    private static ArticleBulkExecutionFramework Framework(
        ArticleBulkExecutorTestFixture fixture,
        IArticleBulkJournalAuthority journal)
        => new(fixture.Planner, journal, fixture.Authority, fixture.Time);

    private static async Task<int> PrepareResumeAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var command = new UnprovedPreparation(fixture.Plan);
        var result = await new ArticleBulkAtomicExecutor(framework, journal, command)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        var before = result.Head.State;
        int validations = fixture.Authority.GroupProofChecks;
        journal = Journal(directory, fixture);
        framework = Framework(fixture, journal);
        var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        var resumed = await framework.ResumeAsync(result.Request, fixture.Plan, admission.Head);
        var resolution = await journal.ResolveIdempotencyAsync(fixture.Input.IdempotencyKey, result.Request.ExecutionIdentityDigest, default);
        await framework.VerifyExecutionAsync(result.Request, fixture.Plan, resumed);
        bool passed = resumed.State == ArticleBulkExecutionState.RecoveryRequired
            && resolution.TerminalReceipt?.ZeroWriteProofDigest is null;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "prepare-resume",
            Before = before.ToString(),
            After = resumed.State.ToString(),
            Outcome = resolution.TerminalReceipt?.GroupCommitOutcome?.ToString(),
            Proof = resolution.TerminalReceipt?.ZeroWriteProofDigest,
            NewGroupProofValidations = fixture.Authority.GroupProofChecks - validations,
            IndependentVerifierAccepted = true,
            command.Calls,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> UnknownRetryAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var command = new UnknownItem(fixture.Plan);
        var result = await new ArticleBulkPerItemExecutor(framework, journal, command)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        bool rejected = false;
        string? reason = null;
        try
        {
            await framework.CreateRetryAsync(result.Request, fixture.Plan, result.Head, "audit-new-attempt",
                new Dictionary<string, string> { [fixture.Plan.Items.First().ArticleId] = "explicit-new-revision" });
        }
        catch (ArticleBulkContractException exception)
        {
            rejected = true;
            reason = exception.Message;
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "unknown-retry",
            State = result.Head.State.ToString(),
            result.Receipt!.RetryEligible,
            UnresolvedRetryRejected = rejected,
            Reason = reason,
            command.Calls,
            Passed = rejected
        }));
        return rejected ? 0 : 1;
    }

    private static async Task<int> ConcurrentUnknownAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.add");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var command = new UnknownItem(fixture.Plan, entered, released);
        var executor = new ArticleBulkPerItemExecutor(framework, journal, command);
        var first = executor.ExecuteAsync(fixture.Plan, fixture.Input);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var secondJournal = Journal(directory, fixture);
        var duplicate = await new ArticleBulkPerItemExecutor(Framework(fixture, secondJournal), secondJournal, command)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        released.SetResult();
        var result = await first;
        await framework.VerifyExecutionAsync(result.Request, fixture.Plan, result.Head);
        bool passed = command.Calls == 1 && duplicate.Head.State == ArticleBulkExecutionState.Executing
            && duplicate.Receipt is null && result.Head.State == ArticleBulkExecutionState.RecoveryRequired
            && result.Receipt!.ZeroWriteProofDigest is null && result.Receipt.SucceededCount == 0;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "concurrent-unknown",
            command.Calls,
            DuplicateState = duplicate.Head.State.ToString(),
            EndState = result.Head.State.ToString(),
            result.Receipt!.SucceededCount,
            result.Receipt.FailedCount,
            result.Receipt.CancelledCount,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> JournalCutAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.remove");
        bool cut = false;
        var journal = Journal(directory, fixture, (stage, _) =>
        {
            if (cut && stage == ArticleBulkFileJournalCommitStage.EnvelopeDurable)
            {
                cut = false;
                throw new IOException("audit-cut-after-envelope-before-pointer");
            }
            return ValueTask.CompletedTask;
        });
        var framework = Framework(fixture, journal);
        var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        cut = true;
        bool injectionObserved = false;
        try
        {
            await framework.AppendAsync(admission.Head, fixture.Plan,
                ArticleBulkJournalEventKind.Admitted, ArticleBulkExecutionState.Admitted);
        }
        catch (IOException)
        {
            injectionObserved = true;
        }
        journal = Journal(directory, fixture);
        framework = Framework(fixture, journal);
        var restored = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        await framework.VerifyJournalAsync(restored.Head);
        var continued = await framework.AppendAsync(restored.Head, fixture.Plan,
            ArticleBulkJournalEventKind.Admitted, ArticleBulkExecutionState.Admitted);
        bool staleRejected = false;
        try
        {
            await framework.AppendAsync(restored.Head, fixture.Plan,
                ArticleBulkJournalEventKind.Admitted, ArticleBulkExecutionState.Admitted);
        }
        catch (ArticleBulkContractException)
        {
            staleRejected = true;
        }
        bool passed = injectionObserved && restored.Head.ContentDigest == admission.Head.ContentDigest
            && continued.Head.State == ArticleBulkExecutionState.Admitted && staleRejected;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "journal-cut",
            InjectionObserved = injectionObserved,
            PreparedEnvelopeIgnored = restored.Head.ContentDigest == admission.Head.ContentDigest,
            StaleHeadRejected = staleRejected,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> JournalAckAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("tag.remove");
        bool cut = false;
        var journal = Journal(directory, fixture, (stage, _) =>
        {
            if (cut && stage == ArticleBulkFileJournalCommitStage.PointerSealed)
            {
                cut = false;
                throw new IOException("audit-cut-after-sealed-pointer-before-ack");
            }
            return ValueTask.CompletedTask;
        });
        var framework = Framework(fixture, journal);
        var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        cut = true;
        bool injectionObserved = false;
        try
        {
            await framework.AppendAsync(admission.Head, fixture.Plan,
                ArticleBulkJournalEventKind.Admitted, ArticleBulkExecutionState.Admitted);
        }
        catch (IOException)
        {
            injectionObserved = true;
        }
        journal = Journal(directory, fixture);
        framework = Framework(fixture, journal);
        var restored = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        await framework.VerifyJournalAsync(restored.Head);
        bool passed = injectionObserved && restored.IsExisting
            && restored.Head.State == ArticleBulkExecutionState.Admitted
            && restored.Head.EventCount == admission.Head.EventCount + 1;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "journal-ack",
            InjectionObserved = injectionObserved,
            RestoredState = restored.Head.State.ToString(),
            restored.Head.EventCount,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> CancelRetryAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.remove");
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var command = new UnknownItem(fixture.Plan);
        using var stop = new CancellationTokenSource();
        stop.Cancel();
        var result = await new ArticleBulkPerItemExecutor(framework, journal, command)
            .ExecuteAsync(fixture.Plan, fixture.Input, stop.Token);
        var replay = await new ArticleBulkPerItemExecutor(framework, journal, command)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        await framework.VerifyExecutionAsync(result.Request, fixture.Plan, result.Head);
        bool retryAdmitted = false;
        string? reason = null;
        try
        {
            await framework.CreateRetryAsync(result.Request, fixture.Plan, result.Head, "audit-cancel-retry",
                new Dictionary<string, string> { [fixture.Plan.Items.First().ArticleId] = fixture.Plan.Items.First().ExpectedRevision! });
            retryAdmitted = true;
        }
        catch (ArticleBulkContractException exception)
        {
            reason = exception.Message;
        }
        bool passed = command.Calls == 0 && result.Head.State == ArticleBulkExecutionState.Cancelled
            && result.Receipt!.CancelledCount == 3 && result.Receipt.ContentDigest == replay.Receipt!.ContentDigest
            && retryAdmitted;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "cancel-retry",
            command.Calls,
            State = result.Head.State.ToString(),
            result.Receipt!.CancelledCount,
            ReplaySameReceipt = result.Receipt.ContentDigest == replay.Receipt!.ContentDigest,
            NotStartedRetryAdmitted = retryAdmitted,
            Reason = reason,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> GroupTerminalCutAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        var head = await ArticleBulkExecutorProtocol.StartAsync(framework, fixture.Plan, admission.Head, default);
        (head, _) = await framework.AppendAsync(head, fixture.Plan,
            ArticleBulkJournalEventKind.GroupCommitStarted, head.State,
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner);
        (head, _) = await framework.AppendAsync(head, fixture.Plan,
            ArticleBulkJournalEventKind.GroupCommitTerminal, head.State,
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner,
            groupOutcome: ArticleBulkGroupCommitOutcome.UnknownRecovery);
        journal = Journal(directory, fixture);
        framework = Framework(fixture, journal);
        var restored = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        var resumed = await framework.ResumeAsync(admission.Request, fixture.Plan, restored.Head);
        var resolution = await journal.ResolveIdempotencyAsync(fixture.Input.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest, default);
        bool passed = resumed.State == ArticleBulkExecutionState.RecoveryRequired;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "group-terminal-cut",
            After = resumed.State.ToString(),
            SameHead = resumed.ContentDigest == restored.Head.ContentDigest,
            GroupOutcome = resumed.GroupCommitOutcome?.ToString(),
            HasAggregate = resolution.TerminalReceipt is not null,
            Passed = passed
        }));
        return passed ? 0 : 1;
    }

    private static async Task<int> PartialGroupProofAsync(string directory)
    {
        var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        var journal = Journal(directory, fixture);
        var framework = Framework(fixture, journal);
        var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
        var head = await ArticleBulkExecutorProtocol.StartAsync(framework, fixture.Plan, admission.Head, default);
        (head, _) = await framework.AppendAsync(head, fixture.Plan,
            ArticleBulkJournalEventKind.GroupCommitStarted, head.State,
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner);
        head = await framework.ResumeAsync(admission.Request, fixture.Plan, head);
        await framework.VerifyExecutionAsync(admission.Request, fixture.Plan, head);
        var truncatedFramework = Framework(fixture, new TruncatedReceipts(journal));
        bool refused = false;
        string? reason = null;
        try
        {
            await truncatedFramework.VerifyExecutionAsync(admission.Request, fixture.Plan, head);
        }
        catch (ArticleBulkContractException exception)
        {
            refused = true;
            reason = exception.Message;
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Probe = "partial-group-proof",
            OriginalCount = fixture.Plan.Impact.EligibleCount,
            ExposedCount = 1,
            PartialRefused = refused,
            Reason = reason,
            Passed = refused
        }));
        return refused ? 0 : 1;
    }

    // Drop evidence from a real sealed unknown-outcome group; never replace or manufacture it.
    private sealed class TruncatedReceipts(IArticleBulkJournalAuthority inner) : IArticleBulkJournalAuthority
    {
        public Task<ArticleBulkIdempotencyResolution> ResolveIdempotencyAsync(string key, string identity, CancellationToken cancellationToken)
            => inner.ResolveIdempotencyAsync(key, identity, cancellationToken);
        public Task<ArticleBulkJournalAppendReceipt> CreateAsync(string key, ArticleBulkExecutionRequest request,
            ArticleBulkJournalEvent firstEvent, ArticleBulkJournalHead firstHead, CancellationToken cancellationToken)
            => inner.CreateAsync(key, request, firstEvent, firstHead, cancellationToken);
        public Task<ArticleBulkJournalAppendReceipt> AppendAsync(ArticleBulkJournalAppend append, CancellationToken cancellationToken)
            => inner.AppendAsync(append, cancellationToken);
        public IAsyncEnumerable<IReadOnlyList<ArticleBulkJournalEvent>> ReadEventBatchesAsync(
            ArticleBulkJournalHead head, int batchSize, CancellationToken cancellationToken)
            => inner.ReadEventBatchesAsync(head, batchSize, cancellationToken);
        public async IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
            ArticleBulkJournalHead head, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            await foreach (var receipt in inner.ReadItemReceiptsAsync(head, cancellationToken))
            {
                yield return receipt;
                yield break;
            }
        }
    }

    private sealed class UnprovedPreparation(ArticleBulkPlan plan) : IArticleBulkAtomicCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public int MaximumAtomicItems => 10_000;
        internal int Calls
        {
            get; private set;
        }

        public Task<ArticleBulkAtomicPreparation> PrepareAsync(ArticleBulkAtomicCommand command, CancellationToken cancellationToken)
        {
            Calls++;
            throw new IOException("audit-reservation-release-has-no-conclusion");
        }
    }

    private sealed class UnknownItem(
        ArticleBulkPlan plan,
        TaskCompletionSource? entered = null,
        TaskCompletionSource? released = null) : IArticleBulkPerItemCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        internal int Calls
        {
            get; private set;
        }

        public async Task<ArticleBulkItemReceipt> ExecuteAsync(ArticleBulkItemCommand command, CancellationToken cancellationToken)
        {
            Calls++;
            entered?.SetResult();
            if (released is not null)
            {
                await released.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            throw new IOException("audit-command-outcome-unknown");
        }
    }
}
