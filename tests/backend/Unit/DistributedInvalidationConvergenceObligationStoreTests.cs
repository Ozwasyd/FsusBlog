using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DistributedInvalidationConvergenceObligationStoreTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PendingPublish_IsDurableIdempotentAndRejectsIdentityOrTopologyMismatch()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(DistributedInvalidationConvergenceObligationEntity));
        var store = new DistributedInvalidationConvergenceObligationStore(db, TimeProvider.System, new DistributedInvalidationConvergenceRuntimeState());
        DistributedInvalidationPublishResult pending = Result("event-a", "topology-a", "article:42", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered);

        DistributedInvalidationConvergenceObligation first = await store.UpsertAsync(pending);
        DistributedInvalidationConvergenceObligation duplicate = await store.UpsertAsync(pending);
        DistributedInvalidationConvergenceSnapshot snapshot = await store.SnapshotAsync();

        Assert.Equal(DistributedInvalidationConvergenceState.PendingRedelivery, first.State);
        Assert.Equal(first.ObligationId, duplicate.ObligationId);
        Assert.Equal(1, db.Queryable<DistributedInvalidationConvergenceObligationEntity>().Count());
        Assert.Equal(1, snapshot.PendingCount);
        Assert.True(snapshot.Degraded);
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(Result("event-a", "topology-b", "article:42", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(Result("event-a", "topology-a", "article:99", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.TransportFailed)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(Result("event-a", "topology-a", "article:42", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered, "article-list")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(Result("event-a", "topology-a", "article:42", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered, kind: DistributedInvalidationEventKinds.CommentMutation)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(Result("event-a", "topology-a", "article:42", DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered, sourceNodeId: "node-b")));
    }

    [Fact]
    public async Task DeliveredPublish_IsSatisfiedAndDoesNotDegradeSnapshot()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(DistributedInvalidationConvergenceObligationEntity));
        var store = new DistributedInvalidationConvergenceObligationStore(db, TimeProvider.System, new DistributedInvalidationConvergenceRuntimeState());

        DistributedInvalidationConvergenceObligation item = await store.UpsertAsync(Result("event-ok", "topology", "article:42", DistributedInvalidationPublishStatus.Published, DistributedInvalidationTransportStatus.Delivered));
        DistributedInvalidationConvergenceSnapshot snapshot = await store.SnapshotAsync();

        Assert.Equal(DistributedInvalidationConvergenceState.Satisfied, item.State);
        Assert.Equal(0, snapshot.PendingCount);
        Assert.Equal(0, snapshot.TerminalFailedCount);
        Assert.False(snapshot.Degraded);
    }

    [Fact]
    public async Task ConcurrentDuplicateEvent_IsAtomicallyIdempotent()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connection);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(firstDb, typeof(DistributedInvalidationConvergenceObligationEntity));
        var firstStore = new DistributedInvalidationConvergenceObligationStore(firstDb, TimeProvider.System, new DistributedInvalidationConvergenceRuntimeState());
        var secondStore = new DistributedInvalidationConvergenceObligationStore(secondDb, TimeProvider.System, new DistributedInvalidationConvergenceRuntimeState());
        DistributedInvalidationPublishResult pending = Result(
            "event-concurrent",
            "topology",
            "article:42",
            DistributedInvalidationPublishStatus.Degraded,
            DistributedInvalidationTransportStatus.UnderDelivered);

        DistributedInvalidationConvergenceObligation[] results = await Task.WhenAll(
            firstStore.UpsertAsync(pending),
            secondStore.UpsertAsync(pending));

        Assert.Equal(results[0].ObligationId, results[1].ObligationId);
        Assert.Equal(
            1,
            firstDb.Queryable<DistributedInvalidationConvergenceObligationEntity>()
                .Where(row => row.RuntimeScope == "scope-a" && row.EventId == "event-concurrent")
                .Count());
    }

    [Fact]
    public async Task PublishAndTransportReceiptMismatch_FailsBeforePersistence()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(DistributedInvalidationConvergenceObligationEntity));
        var store = new DistributedInvalidationConvergenceObligationStore(db, TimeProvider.System, new DistributedInvalidationConvergenceRuntimeState());
        DistributedInvalidationPublishResult inconsistent = Result(
            "event-inconsistent",
            "topology",
            "article:42",
            DistributedInvalidationPublishStatus.Published,
            DistributedInvalidationTransportStatus.UnderDelivered);

        await Assert.ThrowsAsync<InvalidOperationException>(() => store.UpsertAsync(inconsistent));

        Assert.Equal(0, db.Queryable<DistributedInvalidationConvergenceObligationEntity>().Count());
    }

    private static DistributedInvalidationPublishResult Result(
        string eventId,
        string topology,
        string route,
        DistributedInvalidationPublishStatus status,
        DistributedInvalidationTransportStatus transport,
        string cacheTag = "article",
        string kind = DistributedInvalidationEventKinds.ArticleMutation,
        string sourceNodeId = "node-a")
    {
        DistributedInvalidationEvent @event = DistributedInvalidationEvent.Create(eventId, kind, sourceNodeId, "scope-a", [cacheTag], [route], ["public-aot"], "trace", TimeProvider.System);
        return new(status, eventId, status == DistributedInvalidationPublishStatus.Published ? null : "transport", @event,
            new DistributedInvalidationTransportPublishResult("channel", 1, 2, true, DateTimeOffset.UtcNow, transport, topology, "transport"));
    }
}
