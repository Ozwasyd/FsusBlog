using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Audit;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class AuditLogWriterWorkerTests
{
    [Fact]
    public async Task WriteBatchOnceAsync_UsesFreshScopedStorePerBatch()
    {
        var probe = new AuditStoreProbe();
        var services = new ServiceCollection();
        services.AddSingleton(probe);
        services.AddScoped<IAuditLogStore, RecordingAuditLogStore>();

        await using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        var channel = new AuditLogChannel();
        var worker = new AuditLogWriterWorker(
            channel,
            provider.GetRequiredService<IServiceScopeFactory>(),
            new AuditLogRuntimeState(channel),
            new NoopAuditFallbackWriter(),
            NullLogger<AuditLogWriterWorker>.Instance);

        await worker.WriteBatchOnceAsync(
            [new AuditRecord("request", "business", DateTime.UtcNow, "first", null)],
            CancellationToken.None);
        await worker.WriteBatchOnceAsync(
            [new AuditRecord("request", "business", DateTime.UtcNow, "second", null)],
            CancellationToken.None);

        Guid[] scopeIds = probe.ScopeIds.ToArray();
        Assert.Equal(2, scopeIds.Length);
        Assert.Equal(2, scopeIds.Distinct().Count());
    }

    [Fact]
    public async Task PersistSafelyAsync_ContinuesProcessingAfterBatchWriteFailure()
    {
        var probe = new FaultThenRecordProbe();
        var services = new ServiceCollection();
        services.AddSingleton(probe);
        services.AddScoped<IAuditLogStore, FaultThenRecordAuditLogStore>();

        await using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        var channel = new AuditLogChannel();
        var worker = new AuditLogWriterWorker(
            channel,
            provider.GetRequiredService<IServiceScopeFactory>(),
            new AuditLogRuntimeState(channel),
            new NoopAuditFallbackWriter(),
            NullLogger<AuditLogWriterWorker>.Instance);

        await worker.PersistSafelyAsync(
            [new AuditRecord("request", "business", DateTime.UtcNow, "first", null)],
            CancellationToken.None);
        await worker.PersistSafelyAsync(
            [new AuditRecord("request", "business", DateTime.UtcNow, "second", null)],
            CancellationToken.None);

        Assert.Equal(2, probe.Attempts);
        Assert.Equal(1, probe.FailedBatches);
        Assert.Equal(1, probe.SuccessfulBatches);
    }

    private sealed class AuditStoreProbe
    {
        public ConcurrentQueue<Guid> ScopeIds { get; } = new();
    }

    private sealed class RecordingAuditLogStore(AuditStoreProbe probe) : IAuditLogStore
    {
        private readonly AuditStoreProbe _probe = probe;
        private readonly Guid _scopeId = Guid.NewGuid();

        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
        {
            _probe.ScopeIds.Enqueue(_scopeId);
            return Task.CompletedTask;
        }
    }

    private sealed class FaultThenRecordProbe
    {
        public int Attempts;
        public int FailedBatches;
        public int SuccessfulBatches;
    }

    private sealed class FaultThenRecordAuditLogStore(FaultThenRecordProbe probe) : IAuditLogStore
    {
        private readonly FaultThenRecordProbe _probe = probe;

        public Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
        {
            int attempt = Interlocked.Increment(ref _probe.Attempts);
            if (attempt == 1)
            {
                Interlocked.Increment(ref _probe.FailedBatches);
                throw new InvalidOperationException("simulated db failure");
            }

            Interlocked.Increment(ref _probe.SuccessfulBatches);
            return Task.CompletedTask;
        }
    }

    private sealed class NoopAuditFallbackWriter : IAuditFallbackWriter
    {
        public Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }
}
