using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Collection(ArticleBulkMemoryMeasurementCollection.Name)]
public sealed class ArticleBulkFileJournalAuthorityTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 4, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task FreshAuthorityReturnsExactInProgressAttemptWithoutSecondAdmission()
    {
        using var root = new TemporaryRoot();
        FileFixture original = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await original.AdmitAsync();
        (ArticleBulkJournalHead executing, _) = await original.StartExecutingAsync(admission.Head);

        FileFixture restarted = original.Restart();
        ArticleBulkAdmission duplicate = await restarted.AdmitAsync();

        Assert.True(duplicate.IsExisting);
        Assert.Null(duplicate.AppendReceipt);
        Assert.Equal(executing.ContentDigest, duplicate.Head.ContentDigest);
        Assert.Equal(admission.Request.ContentDigest, duplicate.Request.ContentDigest);
        Assert.Equal(ArticleBulkExecutionState.Executing, duplicate.Head.State);
    }

    [Fact]
    public async Task EnvelopeCrashIsNotSealedAndFreshAuthorityCanRetrySameAppend()
    {
        using var root = new TemporaryRoot();
        bool crash = false;
        FileFixture fixture = await FileFixture.CreateAsync(
            root.Path,
            (stage, _) =>
            {
                if (crash && stage == ArticleBulkFileJournalCommitStage.EnvelopeDurable)
                {
                    throw new InjectedCommitCrashException();
                }
                return ValueTask.CompletedTask;
            });
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        crash = true;

        await Assert.ThrowsAsync<InjectedCommitCrashException>(() => fixture.Framework.AppendAsync(
            admission.Head,
            fixture.Plan,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted));

        FileFixture restarted = fixture.Restart();
        ArticleBulkIdempotencyResolution afterCrash = await restarted.Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkIdempotencyKind.InProgress, afterCrash.Kind);
        Assert.Equal(admission.Head.ContentDigest, afterCrash.Head!.ContentDigest);
        Assert.Equal(1, await CountEventsAsync(restarted.Journal, admission.Head));

        (ArticleBulkJournalHead retried, _) = await restarted.Framework.AppendAsync(
            admission.Head,
            restarted.Plan,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted);
        Assert.Equal(ArticleBulkExecutionState.Admitted, retried.State);
        Assert.Equal(2, await CountEventsAsync(restarted.Journal, retried));
    }

    [Fact]
    public async Task PointerCrashIsAlreadyCommittedAndDuplicateAppendIsRejected()
    {
        using var root = new TemporaryRoot();
        bool crash = false;
        FileFixture fixture = await FileFixture.CreateAsync(
            root.Path,
            (stage, _) =>
            {
                if (crash && stage == ArticleBulkFileJournalCommitStage.PointerSealed)
                {
                    throw new InjectedCommitCrashException();
                }
                return ValueTask.CompletedTask;
            });
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        crash = true;

        await Assert.ThrowsAsync<InjectedCommitCrashException>(() => fixture.Framework.AppendAsync(
            admission.Head,
            fixture.Plan,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted));

        FileFixture restarted = fixture.Restart();
        ArticleBulkIdempotencyResolution afterCrash = await restarted.Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkExecutionState.Admitted, afterCrash.Head!.State);
        Assert.Equal(2, await CountEventsAsync(restarted.Journal, afterCrash.Head));
        ArticleBulkContractException error = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            restarted.Framework.AppendAsync(
                admission.Head,
                restarted.Plan,
                ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted));
        Assert.Equal("article-bulk.journal-cas-conflict", error.Code);
    }

    [Fact]
    public async Task FreshAuthorityResumesSealedActiveItemAndPersistsRecoveryReceipt()
    {
        using var root = new TemporaryRoot();
        FileFixture original = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await original.AdmitAsync();
        (ArticleBulkJournalHead executing, _) = await original.StartExecutingAsync(admission.Head);
        (ArticleBulkJournalHead admittedItem, _) = await original.Framework.AppendAsync(
            executing,
            original.Plan,
            ArticleBulkJournalEventKind.ItemAdmitted,
            executing.State,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (ArticleBulkJournalHead active, _) = await original.Framework.AppendAsync(
            admittedItem,
            original.Plan,
            ArticleBulkJournalEventKind.ItemStarted,
            admittedItem.State,
            articleId: "article-00000",
            commandOwner: ArticleBulkOperationRegistry.Get(original.Plan.OperationId).CommandOwner,
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);

        FileFixture restarted = original.Restart();
        ArticleBulkJournalHead recovered = await restarted.Framework.ResumeAsync(
            admission.Request,
            original.Plan,
            active);

        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, recovered.State);
        FileFixture verifier = original.Restart();
        ArticleBulkIdempotencyResolution terminal = await verifier.Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkIdempotencyKind.Terminal, terminal.Kind);
        Assert.Equal(recovered.ContentDigest, terminal.Head!.ContentDigest);
        await verifier.Framework.VerifyExecutionAsync(admission.Request, original.Plan, recovered);
        ArticleBulkItemReceipt receipt = Assert.Single(await ReadReceiptsAsync(verifier.Journal, recovered));
        Assert.Equal(ArticleBulkItemStatus.RecoveryRequired, receipt.ExecutionStatus);
        Assert.Equal("active-command-outcome-unknown", receipt.ReasonCode);
    }

    [Fact]
    public async Task SeparateAuthoritiesSerializeCasSoOnlyOneConcurrentAppendWins()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        FileFixture first = fixture.Restart();
        FileFixture second = fixture.Restart();

        Task<(ArticleBulkJournalHead Head, ArticleBulkJournalAppendReceipt Receipt)> firstAppend =
            first.Framework.AppendAsync(
                admission.Head,
                first.Plan,
                ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted);
        Task<(ArticleBulkJournalHead Head, ArticleBulkJournalAppendReceipt Receipt)> secondAppend =
            second.Framework.AppendAsync(
                admission.Head,
                second.Plan,
                ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted);
        Exception?[] results = await Task.WhenAll(
            CaptureAsync(firstAppend),
            CaptureAsync(secondAppend));

        Assert.Single(results, static error => error is null);
        ArticleBulkContractException conflict = Assert.IsType<ArticleBulkContractException>(
            Assert.Single(results, static error => error is not null));
        Assert.Equal("article-bulk.journal-cas-conflict", conflict.Code);
        ArticleBulkIdempotencyResolution current = await fixture.Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkExecutionState.Admitted, current.Head!.State);
        Assert.Equal(2, current.Head.EventCount);
    }

    [Fact]
    public async Task ConcurrentExactExecuteReturnsOneAdmissionAndOneSameInProgressAttempt()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        FileFixture first = fixture.Restart();
        FileFixture second = fixture.Restart();

        ArticleBulkAdmission[] admissions = await Task.WhenAll(first.AdmitAsync(), second.AdmitAsync());

        Assert.Single(admissions, static admission => !admission.IsExisting);
        Assert.Single(admissions, static admission => admission.IsExisting);
        Assert.Equal(admissions[0].Request.ContentDigest, admissions[1].Request.ContentDigest);
        Assert.Equal(admissions[0].Head.ContentDigest, admissions[1].Head.ContentDigest);
        ArticleBulkIdempotencyResolution persisted = await fixture.Journal.ResolveIdempotencyAsync(
            admissions[0].Request.IdempotencyKey,
            admissions[0].Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkIdempotencyKind.InProgress, persisted.Kind);
        Assert.Equal(1, persisted.Head!.EventCount);
    }

    [Fact]
    public void UnsupportedDurabilityOrUnstableDataRootFailsClosed()
    {
        var time = new FixedTimeProvider(s_now);
        ArticleBulkContractException scope = Assert.Throws<ArticleBulkContractException>(() =>
            new ArticleBulkFileJournalAuthority(
                new ArticleBulkFileJournalOptions(
                    System.IO.Path.GetTempPath(),
                    (ArticleBulkFileJournalDurabilityScope)99),
                time));
        Assert.Equal("article-bulk.journal-filesystem-unsupported", scope.Code);
        ArticleBulkContractException path = Assert.Throws<ArticleBulkContractException>(() =>
            new ArticleBulkFileJournalAuthority(
                new ArticleBulkFileJournalOptions(
                    "relative-data-root",
                    ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename),
                time));
        Assert.Equal("article-bulk.journal-data-root-invalid", path.Code);
    }

    [Fact]
    public async Task ProcessCrashAfterPointerMakesDuplicateObserveSameSealedAttempt()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();

        WorkerProcessResult crashed = await RunWorkerAsync(
            "append-admitted-crash-pointer",
            root.Path);
        Assert.NotEqual(0, crashed.ExitCode);
        Assert.DoesNotContain(ArticleBulkFileJournalProcessWorker.ResultPrefix, crashed.StandardOutput);

        WorkerProcessResult duplicate = await RunWorkerAsync("duplicate", root.Path);
        Assert.Equal(0, duplicate.ExitCode);
        ArticleBulkFileJournalWorkerResult result = ParseWorkerResult(duplicate.StandardOutput);
        Assert.True(result.IsExisting);
        Assert.Equal(ArticleBulkExecutionState.Admitted, result.State);
        Assert.Equal(2, result.EventCount);
        Assert.NotEqual(admission.Head.ContentDigest, result.HeadDigest);
    }

    [Fact]
    public async Task FreshProcessResumesAfterProcessDiesBeforeEnvelopeIsSealed()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        (ArticleBulkJournalHead executing, _) = await fixture.StartExecutingAsync(admission.Head);
        (ArticleBulkJournalHead admittedItem, _) = await fixture.Framework.AppendAsync(
            executing,
            fixture.Plan,
            ArticleBulkJournalEventKind.ItemAdmitted,
            executing.State,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (ArticleBulkJournalHead active, _) = await fixture.Framework.AppendAsync(
            admittedItem,
            fixture.Plan,
            ArticleBulkJournalEventKind.ItemStarted,
            admittedItem.State,
            articleId: "article-00000",
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner,
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);

        WorkerProcessResult crashed = await RunWorkerAsync("resume-crash-envelope", root.Path);
        Assert.NotEqual(0, crashed.ExitCode);
        ArticleBulkIdempotencyResolution afterCrash = await fixture.Restart().Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(active.ContentDigest, afterCrash.Head!.ContentDigest);

        WorkerProcessResult resumed = await RunWorkerAsync("resume", root.Path);
        Assert.Equal(0, resumed.ExitCode);
        ArticleBulkFileJournalWorkerResult resumeResult = ParseWorkerResult(resumed.StandardOutput);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, resumeResult.State);
        Assert.True(resumeResult.EventCount > active.EventCount);

        WorkerProcessResult duplicate = await RunWorkerAsync("duplicate", root.Path);
        Assert.Equal(0, duplicate.ExitCode);
        ArticleBulkFileJournalWorkerResult duplicateResult = ParseWorkerResult(duplicate.StandardOutput);
        Assert.True(duplicateResult.IsExisting);
        Assert.Equal(resumeResult.HeadDigest, duplicateResult.HeadDigest);
    }

    [Fact]
    public async Task FreshProcessContinuesRecoveryAfterRecoveryMarkerPointerWasSealed()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        (ArticleBulkJournalHead executing, _) = await fixture.StartExecutingAsync(admission.Head);
        (ArticleBulkJournalHead admittedItem, _) = await fixture.Framework.AppendAsync(
            executing,
            fixture.Plan,
            ArticleBulkJournalEventKind.ItemAdmitted,
            executing.State,
            articleId: "article-00000",
            nextItemStatus: ArticleBulkItemStatus.Admitted);
        (ArticleBulkJournalHead active, _) = await fixture.Framework.AppendAsync(
            admittedItem,
            fixture.Plan,
            ArticleBulkJournalEventKind.ItemStarted,
            admittedItem.State,
            articleId: "article-00000",
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner,
            expectedItemStatus: ArticleBulkItemStatus.Admitted,
            nextItemStatus: ArticleBulkItemStatus.Executing);

        WorkerProcessResult crashed = await RunWorkerAsync("resume-crash-pointer", root.Path);
        Assert.NotEqual(0, crashed.ExitCode);
        ArticleBulkIdempotencyResolution afterCrash = await fixture.Restart().Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, afterCrash.Head!.State);
        Assert.Equal(active.EventCount + 1, afterCrash.Head.EventCount);
        Assert.Equal("article-00000", Assert.Single(afterCrash.Head.ActiveArticleIds));

        WorkerProcessResult resumed = await RunWorkerAsync("resume", root.Path);
        Assert.Equal(0, resumed.ExitCode);
        ArticleBulkFileJournalWorkerResult result = ParseWorkerResult(resumed.StandardOutput);
        Assert.Equal(ArticleBulkExecutionState.RecoveryRequired, result.State);
        Assert.True(result.EventCount > afterCrash.Head.EventCount);

        ArticleBulkIdempotencyResolution terminal = await fixture.Restart().Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkIdempotencyKind.Terminal, terminal.Kind);
        Assert.Equal(result.HeadDigest, terminal.Head!.ContentDigest);
        await fixture.Restart().Framework.VerifyExecutionAsync(
            admission.Request,
            fixture.Plan,
            terminal.Head);
    }

    [Fact]
    public async Task ConcurrentProcessesUseOneLockAndOneHeadCasWinner()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();

        WorkerProcessResult[] contenders = await Task.WhenAll(
            RunWorkerAsync("append-admitted", root.Path),
            RunWorkerAsync("append-admitted", root.Path));

        Assert.Single(contenders, static result => result.ExitCode == 0);
        WorkerProcessResult rejected = Assert.Single(contenders, static result => result.ExitCode != 0);
        Assert.Contains("article-bulk.journal-cas-conflict", rejected.StandardError, StringComparison.Ordinal);
        ArticleBulkIdempotencyResolution persisted = await fixture.Restart().Journal.ResolveIdempotencyAsync(
            admission.Request.IdempotencyKey,
            admission.Request.ExecutionIdentityDigest,
            CancellationToken.None);
        Assert.Equal(ArticleBulkExecutionState.Admitted, persisted.Head!.State);
        Assert.Equal(2, persisted.Head.EventCount);
    }

    [Fact]
    public async Task TenThousandReceiptsUseBoundedSealedFilesAndFreshAuthorityStreaming()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(
            root.Path,
            itemCount: 10_000,
            operationId: "lifecycle.archive");
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        (ArticleBulkJournalHead head, _) = await fixture.Framework.AppendAsync(
            admission.Head,
            fixture.Plan,
            ArticleBulkJournalEventKind.Admitted,
            ArticleBulkExecutionState.Admitted);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            fixture.Plan,
            ArticleBulkJournalEventKind.ExecutionStarted,
            ArticleBulkExecutionState.Executing);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            fixture.Plan,
            ArticleBulkJournalEventKind.GroupCommitStarted,
            ArticleBulkExecutionState.Executing,
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner);
        string groupReceiptDigest = ArticleBulkDigest.Of("group-commit");
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            fixture.Plan,
            ArticleBulkJournalEventKind.GroupCommitTerminal,
            ArticleBulkExecutionState.Executing,
            commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner,
            commandReceiptDigest: groupReceiptDigest,
            groupOutcome: ArticleBulkGroupCommitOutcome.Committed,
            groupReceiptDigest: groupReceiptDigest);

        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId);
        var receiptChunks = ImmutableArray.CreateBuilder<ArticleBulkReceiptChunk>();
        for (int offset = 0;
            offset < fixture.Plan.Items.Count();
            offset += ArticleBulkExecutionFramework.ReceiptChunkSize)
        {
            ImmutableArray<ArticleBulkItemReceipt> receipts =
            [
                .. fixture.Plan.Items
                    .Skip(offset)
                    .Take(ArticleBulkExecutionFramework.ReceiptChunkSize)
                    .Select(item => CreateSucceededReceipt(admission.Request, fixture.Plan, operation, item))
            ];
            (head, _) = await fixture.Framework.AppendAsync(
                head,
                fixture.Plan,
                ArticleBulkJournalEventKind.ReceiptChunkRecorded,
                ArticleBulkExecutionState.Executing,
                receiptChunk: receipts,
                reasonCode: "group-commit-succeeded");
            var chunk = new ArticleBulkReceiptChunk(
                receiptChunks.Count,
                [.. receipts.Select(static receipt => receipt.ContentDigest)],
                string.Empty);
            receiptChunks.Add(chunk with
            {
                ContentDigest = ArticleBulkDigest.Of(chunk)
            });
        }

        var unsignedAggregate = new ArticleBulkAggregateReceipt(
            admission.Request.AttemptId,
            admission.Request.ContentDigest,
            fixture.Plan.ContentDigest,
            fixture.Plan.RegistryDigest,
            fixture.Plan.OperationId,
            fixture.Plan.Strategy,
            fixture.Plan.FrozenSetDigest,
            10_000,
            10_000,
            10_000,
            0,
            0,
            ArticleBulkExecutionState.Completed,
            ArticleBulkGroupCommitOutcome.Committed,
            groupReceiptDigest,
            null,
            false,
            false,
            receiptChunks.ToImmutable(),
            string.Empty);
        ArticleBulkAggregateReceipt aggregate = ArticleBulkExecutionFramework.SealAggregateReceipt(unsignedAggregate);
        (head, _) = await fixture.Framework.AppendAsync(
            head,
            fixture.Plan,
            ArticleBulkJournalEventKind.ExecutionTerminal,
            ArticleBulkExecutionState.Completed,
            groupOutcome: ArticleBulkGroupCommitOutcome.Committed,
            groupReceiptDigest: groupReceiptDigest,
            aggregateReceipt: aggregate,
            reasonCode: "completed");

        long before = GC.GetTotalMemory(forceFullCollection: true);
        FileFixture verifier = fixture.Restart();
        await verifier.Framework.VerifyExecutionAsync(admission.Request, fixture.Plan, head);
        long retainedBytes = GC.GetTotalMemory(forceFullCollection: true) - before;
        string attemptRoot = GetAttemptRoot(root.Path, admission.Request.IdempotencyKey);
        long storedBytes = Directory.EnumerateFiles(attemptRoot, "*", SearchOption.AllDirectories)
            .Sum(path => new FileInfo(path).Length);

        Assert.Equal(46, head.EventCount);
        Assert.Equal(40, aggregate.ItemReceiptChunks.Length);
        Assert.Equal(head.EventCount, Directory.GetFiles(
            Path.Combine(attemptRoot, "references"),
            "*.json",
            SearchOption.TopDirectoryOnly).Length);
        Assert.True(retainedBytes <= 16 * 1024 * 1024, $"retained bytes: {retainedBytes}");
        Assert.True(storedBytes <= 64 * 1024 * 1024, $"stored bytes: {storedBytes}");
    }

    [Fact]
    public async Task FreshAuthorityRejectsTamperedSealedForwardReference()
    {
        using var root = new TemporaryRoot();
        FileFixture fixture = await FileFixture.CreateAsync(root.Path);
        ArticleBulkAdmission admission = await fixture.AdmitAsync();
        string referencePath = Path.Combine(
            GetAttemptRoot(root.Path, admission.Request.IdempotencyKey),
            "references",
            "00000000000000000000.json");
        string json = await File.ReadAllTextAsync(referencePath);
        const string Marker = "\"envelopeDigest\":\"sha256:";
        int digestOffset = json.IndexOf(Marker, StringComparison.Ordinal) + Marker.Length;
        Assert.True(digestOffset >= Marker.Length);
        char[] tampered = json.ToCharArray();
        tampered[digestOffset] = tampered[digestOffset] == '0' ? '1' : '0';
        await File.WriteAllTextAsync(referencePath, new string(tampered));

        ArticleBulkContractException error = await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            fixture.Restart().Journal.ResolveIdempotencyAsync(
                admission.Request.IdempotencyKey,
                admission.Request.ExecutionIdentityDigest,
                CancellationToken.None));
        Assert.Equal("article-bulk.journal-corrupt", error.Code);
    }

    private static ArticleBulkItemReceipt CreateSucceededReceipt(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkOperation operation,
        ArticleBulkPlanItem item)
        => ArticleBulkExecutionFramework.SealItemReceipt(new ArticleBulkItemReceipt(
            request.AttemptId,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            item.ArticleId,
            item.ExpectedRevision!,
            item.ExpectedRevision,
            $"revision-new-{item.ArticleId}",
            ArticleBulkPlanItemStatus.Eligible,
            ArticleBulkItemStatus.Succeeded,
            "succeeded",
            operation.CommandOwner,
            ArticleBulkDigest.Of($"command-{item.ArticleId}"),
            [
                .. operation.SideEffectOwners.Select(owner => new ArticleBulkSideEffectReceipt(
                    owner,
                    ArticleBulkDigest.Of($"{owner}-{item.ArticleId}")))
            ],
            ArticleBulkDigest.Of($"retry-{item.ArticleId}"),
            string.Empty));

    private static string GetAttemptRoot(string dataRoot, string idempotencyKey)
        => Path.Combine(
            dataRoot,
            "article-bulk",
            "journal-v1",
            "attempts",
            ArticleBulkDigest.Of(idempotencyKey)[7..]);

    private static async Task<Exception?> CaptureAsync(Task task)
    {
        try
        {
            await task;
            return null;
        }
        catch (Exception exception)
        {
            return exception;
        }
    }

    private static async Task<WorkerProcessResult> RunWorkerAsync(string mode, string dataRoot)
    {
        var startInfo = new ProcessStartInfo(PublicAotCrashWorkerProgram.ResolveDotNetHostPath())
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(typeof(PublicAotCrashWorkerProgram).Assembly.Location);
        startInfo.ArgumentList.Add(ArticleBulkFileJournalProcessWorker.Command);
        startInfo.ArgumentList.Add(mode);
        startInfo.ArgumentList.Add(dataRoot);
        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("The article bulk journal worker did not start.");
        Task<string> standardOutput = process.StandardOutput.ReadToEndAsync();
        Task<string> standardError = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TimeoutException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            throw;
        }
        return new WorkerProcessResult(process.ExitCode, await standardOutput, await standardError);
    }

    private static ArticleBulkFileJournalWorkerResult ParseWorkerResult(string standardOutput)
    {
        string line = Assert.Single(standardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.StartsWith(ArticleBulkFileJournalProcessWorker.ResultPrefix, line, StringComparison.Ordinal);
        return JsonSerializer.Deserialize<ArticleBulkFileJournalWorkerResult>(
            line[ArticleBulkFileJournalProcessWorker.ResultPrefix.Length..],
            new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }

    private static async Task<int> CountEventsAsync(
        IArticleBulkJournalAuthority journal,
        ArticleBulkJournalHead head)
    {
        int count = 0;
        await foreach (IReadOnlyList<ArticleBulkJournalEvent> batch in journal.ReadEventBatchesAsync(
            head,
            ArticleBulkExecutionFramework.JournalReadBatchSize,
            CancellationToken.None))
        {
            count += batch.Count;
        }
        return count;
    }

    private static async Task<IReadOnlyList<ArticleBulkItemReceipt>> ReadReceiptsAsync(
        IArticleBulkJournalAuthority journal,
        ArticleBulkJournalHead head)
    {
        var receipts = new List<ArticleBulkItemReceipt>();
        await foreach (ArticleBulkItemReceipt receipt in journal.ReadItemReceiptsAsync(
            head,
            CancellationToken.None))
        {
            receipts.Add(receipt);
        }
        return receipts;
    }

    private sealed class FileFixture(
        string dataRoot,
        ArticleBulkPlan plan,
        ArticleBulkPlanAuthority planAuthority,
        FixedTimeProvider time,
        ArticleBulkFileJournalAuthority journal,
        ArticleBulkExecutionFramework framework)
    {
        internal ArticleBulkPlan Plan { get; } = plan;
        internal ArticleBulkFileJournalAuthority Journal { get; } = journal;
        internal ArticleBulkExecutionFramework Framework { get; } = framework;

        internal static async Task<FileFixture> CreateAsync(
            string dataRoot,
            Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? observer = null,
            int itemCount = 1,
            string operationId = "category.add")
        {
            var time = new FixedTimeProvider(s_now);
            ImmutableArray<string> articleIds =
                [.. Enumerable.Range(0, itemCount).Select(index => $"article-{index:D5}")];
            var selection = new SelectionAuthority(articleIds);
            var planAuthority = new ArticleBulkPlanAuthority(
                selection,
                new PreflightAuthority(),
                time);
            ArticleBulkPlan plan = await planAuthority.CreateAsync(CreateRequest(operationId, articleIds));
            ArticleBulkFileJournalAuthority journal = CreateJournal(dataRoot, time, observer);
            return new FileFixture(
                dataRoot,
                plan,
                planAuthority,
                time,
                journal,
                new ArticleBulkExecutionFramework(
                    planAuthority,
                    journal,
                    new DeterministicExecutionAuthority(),
                    time));
        }

        internal FileFixture Restart()
        {
            ArticleBulkFileJournalAuthority restarted = CreateJournal(dataRoot, time);
            return new FileFixture(
                dataRoot,
                Plan,
                planAuthority,
                time,
                restarted,
                new ArticleBulkExecutionFramework(
                    planAuthority,
                    restarted,
                    new DeterministicExecutionAuthority(),
                    time));
        }

        internal Task<ArticleBulkAdmission> AdmitAsync() => Framework.AdmitAsync(
            Plan,
            Confirmation(Plan),
            "plan-store:one",
            "attempt-1",
            "idempotency-1",
            Plan.Actor,
            Plan.Source,
            Plan.PolicyDigest,
            Plan.PermissionPolicyDigest);

        private static ArticleBulkPlanConfirmation Confirmation(ArticleBulkPlan plan)
        {
            var unsigned = new ArticleBulkPlanConfirmation(
                "confirmation-1",
                plan.PlanIdentity,
                plan.ContentDigest,
                plan.Actor.AuthorityDigest,
                s_now,
                string.Empty);
            return unsigned with
            {
                ContentDigest = ArticleBulkDigest.Of(unsigned)
            };
        }

        internal async Task<(ArticleBulkJournalHead Head, ArticleBulkJournalAppendReceipt Receipt)>
            StartExecutingAsync(ArticleBulkJournalHead head)
        {
            (ArticleBulkJournalHead admitted, _) = await Framework.AppendAsync(
                head,
                Plan,
                ArticleBulkJournalEventKind.Admitted,
                ArticleBulkExecutionState.Admitted);
            return await Framework.AppendAsync(
                admitted,
                Plan,
                ArticleBulkJournalEventKind.ExecutionStarted,
                ArticleBulkExecutionState.Executing);
        }

        private static ArticleBulkFileJournalAuthority CreateJournal(
            string dataRoot,
            TimeProvider time,
            Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? observer = null)
            => new(
                new ArticleBulkFileJournalOptions(
                    dataRoot,
                    ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename),
                time,
                observer);

        private static ArticleBulkPlanRequest CreateRequest(
            string operationId,
            ImmutableArray<string> articleIds)
            => new(
                "plan-1",
                null,
                operationId,
                new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                {
                    [operationId == "category.add" ? "categoryId" : "reasonCode"] =
                        JsonSerializer.SerializeToElement(
                            operationId == "category.add" ? "category-1" : "bulk-request")
                },
                new ArticleBulkSelection(
                    ArticleBulkSelectionKind.Explicit,
                    articleIds,
                    null,
                    ArticleBulkDigest.Of("selection")),
                new ArticleBulkActor("user-1", "site-1", ArticleBulkDigest.Of("actor")),
                new ArticleBulkSource(new string('a', 40), ArticleBulkDigest.Of("build")),
                ArticleBulkDigest.Of("policy"),
                ArticleBulkDigest.Of("permission-policy"),
                s_now,
                s_now.AddMinutes(30));
    }

    private sealed class SelectionAuthority(IEnumerable<string> articleIds) : IArticleBulkSelectionAuthority
    {
        public Task<ArticleBulkSelectionResolution> ResolveAsync(
            ArticleBulkSelection selection,
            ArticleBulkActor actor,
            CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBulkSelectionResolution(
                ArticleBulkDigest.Of("selection-authority"),
                ArticleBulkDigest.Of("selection-resolution"),
                Stream(articleIds, cancellationToken)));
    }

    private sealed class PreflightAuthority : IArticleBulkPreflightAuthority
    {
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
                yield return new ArticleBulkArticleObservation(
                    articleId,
                    Exists: true,
                    SiteId: actor.SiteId,
                    Revision: $"revision-{articleId}",
                    Lifecycle: "inbox",
                    Permitted: true,
                    Applicable: true,
                    PermissionDigest: ArticleBulkDigest.Of($"permission-{articleId}"),
                    StateDigest: ArticleBulkDigest.Of($"state-{articleId}"),
                    DependencyDigests: [ArticleBulkDigest.Of($"dependency-{articleId}")]);
                await Task.Yield();
            }
        }
    }

    private sealed class DeterministicExecutionAuthority : IArticleBulkExecutionAuthority
    {
        public Task<ArticleBulkExecutionAuthoritySnapshot> ReadCurrentAsync(
            ArticleBulkPlan plan,
            CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBulkExecutionAuthoritySnapshot(
                plan.PolicyDigest,
                plan.PermissionPolicyDigest,
                ArticleBulkDigest.Of("execution-authority"),
                !plan.Executable && plan.Strategy == ArticleBulkExecutionStrategy.AllOrNothing
                    ? ArticleBulkDigest.Of("canonical-zero-write")
                    : null));

        public Task ValidateGroupOutcomeAsync(
            ArticleBulkPlan plan,
            ArticleBulkGroupCommitOutcome outcome,
            string? groupReceiptDigest,
            string? zeroWriteProofDigest,
            CancellationToken cancellationToken)
            => Task.CompletedTask;
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

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }

    private sealed class TemporaryRoot : IDisposable
    {
        internal TemporaryRoot()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "fsusblog-article-bulk-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        internal string Path
        {
            get;
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch (DirectoryNotFoundException)
            {
            }
        }
    }

    private sealed class InjectedCommitCrashException : Exception;

    private sealed record WorkerProcessResult(int ExitCode, string StandardOutput, string StandardError);
}
