using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class AuditLogChannelTests
{
    [Fact]
    public void TryWrite_DropsOverflowAndTracksDroppedCount()
    {
        var channel = new AuditLogChannel(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

        bool first = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "one", null));
        bool second = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "two", null));

        Assert.True(first);
        Assert.False(second);
        Assert.Equal(1, channel.DrainDroppedCount());
        Assert.Equal(0, channel.DrainDroppedCount());
    }

    [Fact]
    public void TryWrite_DurableRecordUsesIndependentLaneWhenBestEffortChannelIsFull()
    {
        var channel = new AuditLogChannel(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

        bool bestEffort = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "normal", null));
        bool durable = channel.TryWrite(new AuditRecord("security", "security", DateTime.UtcNow, "critical", null, IsHighValue: true));
        bool overflow = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "overflow", null));

        Assert.True(bestEffort);
        Assert.True(durable);
        Assert.False(overflow);
        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(2, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.DroppedCount);
        Assert.Equal(1, snapshot.DroppedBySourceType["request:business"]);
    }

    [Fact]
    public async Task AdminAuditLogChannel_QueuesAndFlushesBatch()
    {
        var store = new FakeAdminAuditLogStore();
        using ServiceProvider services = CreateServices(store);
        var channel = new AdminAuditLogChannel(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogChannel>.Instance);
        var worker = new AdminAuditLogWriterWorker(
            channel,
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogWriterWorker>.Instance);

        await channel.EnqueueAsync(CreateAdminAudit("admin.login.completed"));
        await channel.EnqueueAsync(CreateAdminAudit("admin.step_up.completed"));
        var batch = new List<AdminAuditLog>();
        while (channel.TryRead(out AdminAuditLog? audit))
        {
            batch.Add(audit);
        }

        await worker.FlushPendingAsync(batch, CancellationToken.None);

        Assert.Single(store.Batches);
        Assert.Equal(["admin.login.completed", "admin.step_up.completed"], store.Batches[0].Select(static audit => audit.Action).ToArray());
    }

    [Fact]
    public async Task AdminAuditLogWriterWorker_FallsBackWhenBatchWriteFails()
    {
        var store = new FakeAdminAuditLogStore { FailNextWrite = true };
        using ServiceProvider services = CreateServices(store);
        var channel = new AdminAuditLogChannel(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogChannel>.Instance);
        var worker = new AdminAuditLogWriterWorker(
            channel,
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AdminAuditLogWriterWorker>.Instance);
        AdminAuditLog audit = CreateAdminAudit("admin.session.revoked");

        await worker.FlushPendingAsync([audit], CancellationToken.None);

        Assert.Equal(2, store.AttemptCount);
        Assert.Single(store.Batches);
        Assert.Equal("admin.session.revoked", store.Batches[0][0].Action);
    }

    private static ServiceProvider CreateServices(IAdminAuditLogStore store)
        => new ServiceCollection()
            .AddSingleton(store)
            .BuildServiceProvider();

    private static AdminAuditLog CreateAdminAudit(string action)
        => new()
        {
            AdminPrincipalId = 1,
            AdminSessionId = "session-1",
            Action = action,
            Outcome = "success",
            IsHighImpact = true,
            MetadataJson = "{}",
            OccurredAtUtc = DateTime.UtcNow
        };

    private sealed class FakeAdminAuditLogStore : IAdminAuditLogStore
    {
        public List<AdminAuditLog[]> Batches { get; } = [];

        public int AttemptCount
        {
            get; private set;
        }

        public bool FailNextWrite
        {
            get; set;
        }

        public Task WriteBatchAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
        {
            AttemptCount++;
            if (FailNextWrite)
            {
                FailNextWrite = false;
                throw new InvalidOperationException("synthetic batch failure");
            }

            Batches.Add(audits.ToArray());
            return Task.CompletedTask;
        }
    }
}
