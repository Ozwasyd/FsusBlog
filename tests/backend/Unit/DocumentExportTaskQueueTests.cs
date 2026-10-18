using System.Runtime.InteropServices;

using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

// These are scheduling controls over canonical contract fixtures, not article
// admission, provider, host-stop, persistence, or product qualification receipts.
public sealed class DocumentExportTaskQueueTests
{
    [Fact]
    public async Task DuplicateConcurrentAdmission_ProducesOneClaimAndPreservesFirstTaskIdentity()
    {
        var queue = Queue();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask original = CreateTask(input, 1);
        DocumentExportQueueSnapshot first = await queue.EnqueueAsync(original, input);
        DocumentExportQueueSnapshot[] duplicates = await Task.WhenAll(
            Enumerable.Range(2, 64).Select(index => Task.Run(() => queue.EnqueueAsync(
                DocumentExportContractValidator.Seal(original with
                {
                    TaskId = $"duplicate-{index}",
                    RequestId = $"duplicate-request-{index}"
                }), input))));

        Assert.All(duplicates, snapshot => Assert.Equal(first, snapshot));
        Assert.NotNull(await queue.TryClaimAsync());
        Assert.Null(await queue.TryClaimAsync());
    }

    [Fact]
    public async Task SameIdempotencyKeyWithDifferentInput_RefusesReplacement()
    {
        var queue = Queue();
        DocumentExportFrozenInput first = DocumentExportContractTests.ValidInput("old article");
        DocumentExportFrozenInput changed = DocumentExportContractTests.ValidInput("edited article");
        await queue.EnqueueAsync(CreateTask(first, 1), first);
        DocumentExportTask other = DocumentExportContractValidator.Seal(CreateTask(changed, 2) with
        {
            IdempotencyKey = "idempotency-1"
        });

        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.EnqueueAsync(other, changed));
        DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        (DocumentExportTask task, DocumentExportFrozenInput input) = await queue.StartAsync(claim);
        Assert.Equal(first.ContentDigest, input.ContentDigest);
        Assert.Equal(first.ContentDigest, task.InputDigest);
    }

    [Fact]
    public async Task FrozenSourceAndAssets_AreCopiedAtAdmissionAndAtWorkerDelivery()
    {
        var queue = Queue();
        DocumentExportFrozenInput original = DocumentExportContractTests.ValidInput();
        byte[] source = original.MarkdownUtf8.ToArray();
        byte[] asset = original.Assets[0].Bytes.ToArray();
        DocumentExportFrozenInput aliased = original with
        {
            MarkdownUtf8 = ImmutableCollectionsMarshal.AsImmutableArray(source),
            Assets = original.Assets.SetItem(0, original.Assets[0] with
            {
                Bytes = ImmutableCollectionsMarshal.AsImmutableArray(asset)
            })
        };
        await queue.EnqueueAsync(CreateTask(aliased, 1), aliased);
        source[0] ^= 1;
        asset[0] ^= 1;
        DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        (DocumentExportTask task, DocumentExportFrozenInput delivered) = await queue.StartAsync(claim);
        DocumentExportContractValidator.Validate(task, delivered);
        Assert.Equal(original.MarkdownUtf8.ToArray(), delivered.MarkdownUtf8.ToArray());
        Assert.Equal(original.Assets[0].Bytes.ToArray(), delivered.Assets[0].Bytes.ToArray());

        ImmutableCollectionsMarshal.AsArray(delivered.MarkdownUtf8)![0] ^= 1;
        // Independent duplicate admission still observes the original owned input.
        Assert.Equal(task.InputDigest, (await queue.ReadAsync(task.UserId, task.SiteId, task.TaskId)).Task.InputDigest);
    }

    [Fact]
    public async Task ActiveCancellation_RetainsSlotUntilCleanupAndDoesNotOverwriteFirstStop()
    {
        var queue = Queue(maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await queue.EnqueueAsync(CreateTask(input, 2), input);
        DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await queue.StartAsync(claim);

        DocumentExportQueueSnapshot cancelling = await queue.CancelAsync(input.UserId, input.SiteId, claim.TaskId);
        Assert.Equal(DocumentExportTaskStatus.Cancelling, cancelling.Task.Status);
        Assert.True(claim.CancellationToken.IsCancellationRequested);
        Assert.Null(await queue.TryClaimAsync());
        DocumentExportQueueSnapshot obligation = await queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: false);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, obligation.Task.Status);
        Assert.True(obligation.ExecutionOutstanding);
        Assert.Null(await queue.TryClaimAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Failed, cleanupComplete: true));

        DocumentExportQueueSnapshot cancelled = await queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, cancelled.Task.Status);
        Assert.False(cancelled.ExecutionOutstanding);
        Assert.Equal(cancelled, await queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true));
        Assert.NotNull(await queue.TryClaimAsync());
        Assert.Null(await queue.TryClaimAsync());
    }

    [Fact]
    public async Task QueuedCancellation_RemovesOnlyItsPendingNodeAndNeverStartsIt()
    {
        var queue = Queue();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await queue.EnqueueAsync(CreateTask(input, 2), input);
        DocumentExportQueueSnapshot cancelled = await queue.CancelAsync(input.UserId, input.SiteId, "task-1");
        Assert.Equal(DocumentExportTaskStatus.Cancelled, cancelled.Task.Status);
        Assert.Equal("task-2", (await queue.TryClaimAsync())!.TaskId);
        Assert.Null(await queue.TryClaimAsync());
        Assert.Equal(cancelled, await queue.CancelAsync(input.UserId, input.SiteId, "task-1"));
    }

    [Fact]
    public async Task Expiry_AbortsAllActiveClaimsAndPreservesOutstandingCleanup()
    {
        var clock = new ManualClock();
        var queue = Queue(clock, maxConcurrency: 2);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await queue.EnqueueAsync(CreateTask(input, 2), input);
        DocumentExportTaskClaim first = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        DocumentExportTaskClaim second = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        using CancellationTokenRegistration failingCallback = first.CancellationToken.Register(
            () => throw new InvalidOperationException("callback refusal"));
        clock.Advance(TimeSpan.FromMinutes(5));

        await Assert.ThrowsAsync<AggregateException>(() => queue.ExpireAsync());
        Assert.True(first.CancellationToken.IsCancellationRequested);
        Assert.True(second.CancellationToken.IsCancellationRequested);
        Assert.Equal(DocumentExportTaskStatus.Expired,
            (await queue.ReadAsync(input.UserId, input.SiteId, first.TaskId)).Task.Status);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.StartAsync(first));
        DocumentExportQueueSnapshot stillExpired = await queue.AcknowledgeStoppedAsync(
            first, DocumentExportProviderResultStatus.Failed, cleanupComplete: false);
        Assert.Equal(DocumentExportTaskStatus.Expired, stillExpired.Task.Status);
        Assert.True(stillExpired.ExecutionOutstanding);
        await queue.AcknowledgeStoppedAsync(first, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        await queue.ExpireAsync();
        await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.ReadAsync(input.UserId, input.SiteId, first.TaskId));
        Assert.True((await queue.ReadAsync(input.UserId, input.SiteId, second.TaskId)).ExecutionOutstanding);
    }

    [Fact]
    public async Task ExpiredQueuedRecords_ReleaseQuotaAndCannotReviveOldClaims()
    {
        var clock = new ManualClock();
        var queue = Queue(clock, maxTasks: 1, maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        DocumentExportTaskClaim old = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await queue.AcknowledgeStoppedAsync(old, DocumentExportProviderResultStatus.Blocked, cleanupComplete: true);
        clock.Advance(TimeSpan.FromMinutes(5));
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        DocumentExportTaskClaim current = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.StartAsync(old));
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.AcknowledgeStoppedAsync(
            old, DocumentExportProviderResultStatus.Blocked, cleanupComplete: true));
        Assert.Equal(DocumentExportTaskStatus.Running, (await queue.StartAsync(current)).Task.Status);
    }

    [Fact]
    public async Task AuthorizationMisses_AreUniformAndCannotCancelOtherOwners()
    {
        var queue = Queue();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        foreach ((long user, long site, string id) in new[]
        {
            (0L, input.SiteId, "task-1"),
            (input.UserId + 1, input.SiteId, "task-1"),
            (input.UserId, input.SiteId + 1, "task-1"),
            (input.UserId, input.SiteId, "missing")
        })
        {
            KeyNotFoundException read = await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.ReadAsync(user, site, id));
            KeyNotFoundException cancel = await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.CancelAsync(user, site, id));
            Assert.Equal("Export task is unavailable.", read.Message);
            Assert.Equal(read.Message, cancel.Message);
        }
        Assert.Equal(DocumentExportTaskStatus.Queued, (await queue.ReadAsync(input.UserId, input.SiteId, "task-1")).Task.Status);
    }

    [Fact]
    public async Task CapacityAndConcurrency_AreBoundedForOneThousandTasks()
    {
        var queue = Queue(maxTasks: 1000, maxConcurrency: 2);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await Task.WhenAll(Enumerable.Range(1, 1000).Select(index => Task.Run(
            () => queue.EnqueueAsync(CreateTask(input, index), input))));
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.EnqueueAsync(CreateTask(input, 1001), input));
        DocumentExportTaskClaim?[] claims = await Task.WhenAll(
            Enumerable.Range(1, 1000).Select(_ => Task.Run(() => queue.TryClaimAsync())));
        Assert.Equal(2, claims.Count(claim => claim is not null));
        Assert.Equal(2, claims.Where(claim => claim is not null).Select(claim => claim!.TaskId).Distinct().Count());
    }

    [Fact]
    public async Task ByteQuota_IsRetainedUntilExpiryEvenAfterCancellation()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        long bytes = DocumentExportDigest.Serialize(input).LongLength;
        var clock = new ManualClock();
        var queue = Queue(clock, maxFrozenBytes: bytes);
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await queue.CancelAsync(input.UserId, input.SiteId, "task-1");
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.EnqueueAsync(CreateTask(input, 2), input));
        clock.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal("task-2", (await queue.EnqueueAsync(CreateTask(input, 2), input)).Task.TaskId);
    }

    [Theory]
    [InlineData("pdf")]
    [InlineData("docx")]
    [InlineData("epub")]
    public async Task UnimplementedExactProvider_IsRefusedWithoutFallback(string format)
    {
        var queue = Queue();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(format);
        DocumentExportTask task = DocumentExportContractValidator.Seal(CreateTask(input, 1) with
        {
            FormatId = provider.FormatId,
            ProviderId = provider.ProviderId,
            ProviderVersion = provider.ProviderVersion
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.EnqueueAsync(task, input));
        Assert.Null(await queue.TryClaimAsync());
    }

    [Fact]
    public async Task ForgedClaimTamperAndSuccessAcknowledgement_AreRefused()
    {
        var queue = Queue();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = CreateTask(input, 1);
        await Assert.ThrowsAsync<InvalidDataException>(() => queue.EnqueueAsync(task with { InputDigest = "tampered" }, input));
        await queue.EnqueueAsync(task, input);
        DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.StartAsync(
            new DocumentExportTaskClaim(claim.TaskId, CancellationToken.None)));
        await queue.StartAsync(claim);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.StartAsync(claim));
        await Assert.ThrowsAsync<ArgumentException>(() => queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Succeeded, cleanupComplete: true));
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.AcknowledgeStoppedAsync(
            claim, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true));
        Assert.Equal(DocumentExportTaskStatus.Running, (await queue.ReadAsync(input.UserId, input.SiteId, claim.TaskId)).Task.Status);
    }

    [Fact]
    public async Task CancellationCallbacks_CanQueryAndAcknowledgeWithoutTheSchedulingLock()
    {
        var queue = Queue(maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await queue.EnqueueAsync(CreateTask(input, 2), input);
        DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        using CancellationTokenRegistration callback = claim.CancellationToken.Register(() =>
        {
            Assert.Equal(DocumentExportTaskStatus.Cancelling,
                queue.ReadAsync(input.UserId, input.SiteId, claim.TaskId).GetAwaiter().GetResult().Task.Status);
            queue.AcknowledgeStoppedAsync(claim, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true)
                .GetAwaiter().GetResult();
        });
        DocumentExportQueueSnapshot cancelled = await queue.CancelAsync(input.UserId, input.SiteId, claim.TaskId)
            .WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(DocumentExportTaskStatus.Cancelled, cancelled.Task.Status);
        Assert.NotNull(await queue.TryClaimAsync());
    }

    [Fact]
    public void InvalidSchedulingLimits_CannotExpandCatalogConcurrencyOrRetention()
    {
        var valid = new DocumentExportQueueLimits(1000, 2, 67108864, TimeSpan.FromMinutes(5));
        foreach (DocumentExportQueueLimits invalid in new[]
        {
            valid with { MaxTasks = 0 },
            valid with { MaxTasks = 1001 },
            valid with { MaxConcurrency = 0 },
            valid with { MaxAttempts = 0 },
            valid with { MaxAttempts = 4 },
            valid with { MaxConcurrency = 3 },
            valid with { MaxFrozenBytes = 0 },
            valid with { MaxFrozenBytes = 1073741825 },
            valid with { RetentionTtl = TimeSpan.Zero },
            valid with { RetentionTtl = TimeSpan.FromHours(25) }
        })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new DocumentExportTaskQueue(new ManualClock(), invalid));
        }
    }

    [Fact]
    public async Task IdempotencyScopes_SeparateUsersAndSitesWithoutExposingTheirTasks()
    {
        var queue = Queue();
        DocumentExportFrozenInput original = DocumentExportContractTests.ValidInput();
        DocumentExportFrozenInput otherUser = DocumentExportContractValidator.Seal(original with
        {
            UserId = original.UserId + 1
        });
        DocumentExportFrozenInput otherSite = DocumentExportContractValidator.Seal(original with
        {
            SiteId = original.SiteId + 1
        });
        DocumentExportFrozenInput[] inputs = [original, otherUser, otherSite];
        for (int index = 0; index < inputs.Length; index++)
        {
            DocumentExportTask task = DocumentExportContractValidator.Seal(CreateTask(inputs[index], index + 1) with
            {
                IdempotencyKey = "shared-key"
            });
            Assert.Equal(task.TaskId, (await queue.EnqueueAsync(task, inputs[index])).Task.TaskId);
        }
        await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.ReadAsync(original.UserId, original.SiteId, "task-2"));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.ReadAsync(original.UserId, original.SiteId, "task-3"));
        Assert.Equal("task-1", (await queue.TryClaimAsync())!.TaskId);
        Assert.Equal("task-2", (await queue.TryClaimAsync())!.TaskId);
        Assert.Null(await queue.TryClaimAsync());
    }

    [Fact]
    public async Task Retry_PreservesFirstFailureAndFrozenIdentityWhileMintingANewAttempt()
    {
        var queue = Queue(maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        DocumentExportTaskClaim first = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await queue.StartAsync(first);
        DocumentExportQueueSnapshot failed = await queue.AcknowledgeStoppedAsync(
            first, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        DocumentExportAttemptSnapshot firstReceipt = failed.CurrentAttempt;
        DocumentExportQueueSnapshot retry = await queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-request-2");
        Assert.Equal(failed.Task, retry.Task);
        Assert.Equal(DocumentExportTaskStatus.Failed, retry.Task.Status);
        Assert.Equal(DocumentExportProviderResultStatus.Failed, retry.StopOutcome);
        Assert.Equal(DocumentExportTaskStatus.Queued, retry.CurrentAttempt.Status);
        Assert.NotEqual(firstReceipt.AttemptId, retry.CurrentAttempt.AttemptId);
        Assert.Equal(2, retry.CurrentAttempt.Number);
        Assert.Equal(retry, await queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-request-2"));
        DocumentExportTaskClaim second = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        (DocumentExportTask task, DocumentExportFrozenInput frozen) = await queue.StartAsync(second);
        Assert.Equal(input.ContentDigest, frozen.ContentDigest);
        Assert.Equal(input.ContentDigest, task.InputDigest);
        Assert.Equal("retry-request-2", task.RequestId);
        Assert.Equal(DocumentExportTaskStatus.Running, task.Status);
        // A delayed duplicate completion of the old attempt never frees this slot.
        await queue.AcknowledgeStoppedAsync(first, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        Assert.Null(await queue.TryClaimAsync());
        Assert.True((await queue.ReadAsync(input.UserId, input.SiteId, first.TaskId)).ExecutionOutstanding);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.StartAsync(first));
        IReadOnlyList<DocumentExportAttemptSnapshot> history = await queue.ReadAttemptsAsync(input.UserId, input.SiteId, first.TaskId);
        Assert.Equal(firstReceipt, history[0]);
        Assert.Equal(DocumentExportDigest.Compute(history[1] with
        {
            ContentDigest = string.Empty
        }), history[1].ContentDigest);
        await queue.AcknowledgeStoppedAsync(second, DocumentExportProviderResultStatus.Blocked, cleanupComplete: true);
        Assert.Equal(DocumentExportProviderResultStatus.Failed,
            (await queue.ReadAsync(input.UserId, input.SiteId, first.TaskId)).StopOutcome);
    }

    [Fact]
    public async Task Retry_RefusesPendingCleanupAndCapsAttemptsWithoutExtendingExpiry()
    {
        var queue = Queue(maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportQueueSnapshot admitted = await queue.EnqueueAsync(CreateTask(input, 1), input);
        DocumentExportTaskClaim first = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await queue.AcknowledgeStoppedAsync(first, DocumentExportProviderResultStatus.Failed, cleanupComplete: false);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-2"));
        await queue.AcknowledgeStoppedAsync(first, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        for (int attempt = 2; attempt <= 3; attempt++)
        {
            DocumentExportQueueSnapshot retry = await queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, $"retry-{attempt}");
            Assert.Equal(admitted.ExpiresAtUtc, retry.ExpiresAtUtc);
            DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
            await queue.AcknowledgeStoppedAsync(claim, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-4"));
        Assert.Equal(3, (await queue.ReadAttemptsAsync(input.UserId, input.SiteId, first.TaskId)).Count);
        Assert.Null(await queue.TryClaimAsync());
    }

    [Fact]
    public async Task RetryCancellationAndExpiry_CannotOverwriteOriginalTerminalOrLeakCapacity()
    {
        var clock = new ManualClock();
        var queue = Queue(clock, maxConcurrency: 1);
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        DocumentExportTaskClaim first = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        DocumentExportQueueSnapshot failed = await queue.AcknowledgeStoppedAsync(
            first, DocumentExportProviderResultStatus.Failed, cleanupComplete: true);
        await queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-2");
        DocumentExportTaskClaim second = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
        await queue.CancelAsync(input.UserId, input.SiteId, first.TaskId);
        Assert.True(second.CancellationToken.IsCancellationRequested);
        DocumentExportQueueSnapshot cancelled = await queue.AcknowledgeStoppedAsync(
            second, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true);
        Assert.Equal(failed.Task, cancelled.Task);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, cancelled.CurrentAttempt.Status);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.RetryAsync(input.UserId, input.SiteId, first.TaskId, "retry-3"));
        clock.Advance(TimeSpan.FromMinutes(5));
        await queue.ExpireAsync();
        await Assert.ThrowsAsync<KeyNotFoundException>(() => queue.ReadAttemptsAsync(input.UserId, input.SiteId, first.TaskId));
        await queue.EnqueueAsync(CreateTask(input, 1), input);
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.AcknowledgeStoppedAsync(
            second, DocumentExportProviderResultStatus.Cancelled, cleanupComplete: true));
    }

    private static DocumentExportTask CreateTask(DocumentExportFrozenInput input, int index)
        => DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            TaskId = $"task-{index}",
            RequestId = $"request-{index}",
            IdempotencyKey = $"idempotency-{index}"
        });

    private static DocumentExportTaskQueue Queue(
        ManualClock? clock = null,
        int maxTasks = 1000,
        int maxConcurrency = 2,
        long maxFrozenBytes = 67108864)
        => new(clock ?? new ManualClock(), new DocumentExportQueueLimits(
            maxTasks, maxConcurrency, maxFrozenBytes, TimeSpan.FromMinutes(5)));

    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan interval) => _now += interval;
    }
}
