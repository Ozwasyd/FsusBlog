using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class PublicMutationFenceLeaseTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RecoveryWorker_PromotesOnlyAfterWriterSessionLockEnds()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = fixture.BuildDatabaseConnectionString(databaseName)
            })
            .Build();
        int articleId = Random.Shared.Next(1_000_000, 2_000_000_000);
        var pending = new PublicArtifactTombstone(
            articleId,
            Generation: 71,
            RevokedAtUnixMilliseconds: 100,
            PurgeConfirmed: true,
            TransitionPending: true);
        var stateStore = Substitute.For<IPublicArtifactRevocationStateStore>();
        stateStore.LoadActiveAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IReadOnlyList<PublicArtifactTombstone>>([pending]));
        var revocations = Substitute.For<IPublicArtifactRevocationCoordinator>();
        revocations.RecoverPendingMutationFenceAsync(pending, Arg.Any<CancellationToken>())
            .Returns(true);
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }));
        var keyScope = new PrefixRuntimeKeyScope("lease-recovery-a:");
        var worker = new PublicMutationFenceRecoveryWorker(
            configuration,
            keyScope,
            stateStore,
            revocations,
            queue,
            Options.Create(new PublicArtifactRevocationOptions()),
            NullLogger<PublicMutationFenceRecoveryWorker>.Instance);
        var writerLease = new PostgresPublicMutationFenceLease(
            configuration,
            keyScope,
            NullLogger<PostgresPublicMutationFenceLease>.Instance);
        await writerLease.AcquireAsync(articleId);

        int whileWriterAlive = await worker.RecoverOnceAsync(CancellationToken.None);

        Assert.Equal(0, whileWriterAlive);
        await revocations.DidNotReceive()
            .RecoverPendingMutationFenceAsync(pending, Arg.Any<CancellationToken>());
        await writerLease.DisposeAsync();

        int afterWriterEnded = await worker.RecoverOnceAsync(CancellationToken.None);

        Assert.Equal(1, afterWriterEnded);
        await revocations.Received(1)
            .RecoverPendingMutationFenceAsync(pending, Arg.Any<CancellationToken>());
        Assert.Equal(1, queue.QueuedCount);
    }

    [Fact]
    public async Task AdvisoryLock_UsesRuntimeScopeAndDoesNotCrossBlockSameArticleId()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = fixture.BuildDatabaseConnectionString(databaseName)
            })
            .Build();
        int articleId = Random.Shared.Next(1_000_000, 2_000_000_000);
        var first = new PostgresPublicMutationFenceLease(
            configuration,
            new PrefixRuntimeKeyScope("lease-scope-a:"),
            NullLogger<PostgresPublicMutationFenceLease>.Instance);
        var second = new PostgresPublicMutationFenceLease(
            configuration,
            new PrefixRuntimeKeyScope("lease-scope-b:"),
            NullLogger<PostgresPublicMutationFenceLease>.Instance);

        try
        {
            await first.AcquireAsync(articleId);
            await second.AcquireAsync(articleId);
        }
        finally
        {
            await first.DisposeAsync();
            await second.DisposeAsync();
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}
