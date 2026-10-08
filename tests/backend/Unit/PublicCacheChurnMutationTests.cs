using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicCacheChurnMutationTests
{
    [Fact]
    public async Task MutationAndCleanup_RetainExactEntityInvalidationAndEnqueueReceipts()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactUpdateQueue queue = CreateQueue(state);

        BinaryEndpoints.CategoryMutationReceipt created = await BinaryEndpoints.CreateCategoryAndDispatchAsync(
            db, invalidation, dispatcher, queue, "soak-owned-canary", "run-owned-payload", CancellationToken.None);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.Created, created.Outcome);
        Category row = await db.Queryable<Category>().InSingleAsync(created.CategoryId);
        Assert.Equal("soak-owned-canary", row.Name);
        Assert.Equal("run-owned-payload", row.Description);
        PublicHotArtifactObligation mutationObligation = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(mutationObligation.ObligationId, created.Delivery!.Value.ObligationId);
        Assert.Equal(mutationObligation.TargetGeneration, created.Delivery.Value.DeliveryGeneration);
        await dispatcher.Received(1).InvalidateCategoryTagAsync(created.MutationId, CancellationToken.None);

        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-concurrent-update");
        PublicHotArtifactObligation coalesced = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.True(coalesced.TargetGeneration > created.Delivery.Value.DeliveryGeneration);
        Assert.Equal(mutationObligation.TargetGeneration, created.Delivery.Value.DeliveryGeneration);

        BinaryEndpoints.CategoryMutationReceipt cleanup = await BinaryEndpoints.DeleteCategoryAndDispatchAsync(
            db, invalidation, dispatcher, queue, created.CategoryId, CancellationToken.None);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.Deleted, cleanup.Outcome);
        Assert.Equal(created.CategoryId, cleanup.CategoryId);
        Assert.NotEqual(created.MutationId, cleanup.MutationId);
        Assert.False(await db.Queryable<Category>().AnyAsync(category => category.Id == created.CategoryId));
        PublicHotArtifactObligation cleanupObligation = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(cleanupObligation.ObligationId, cleanup.Delivery!.Value.ObligationId);
        Assert.Equal(cleanupObligation.TargetGeneration, cleanup.Delivery.Value.DeliveryGeneration);
        Assert.True(cleanup.Delivery.Value.DeliveryGeneration > created.Delivery.Value.DeliveryGeneration);
        await dispatcher.Received(1).InvalidateCategoryTagAsync(cleanup.MutationId, CancellationToken.None);
        await invalidation.Received(2).RemoveAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            TaxonomyExactMetadataCache.ForCategory(created.CategoryId), CancellationToken.None);
    }

    [Fact]
    public async Task RepeatedCleanup_DoesNotInventAnotherMutationOrGeneration()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactUpdateQueue queue = CreateQueue(state);
        int categoryId = await BinaryEndpoints.CreateCategoryAsync(db, "owned", null, CancellationToken.None);
        await BinaryEndpoints.DeleteCategoryAndDispatchAsync(db, invalidation, dispatcher, queue, categoryId, CancellationToken.None);
        long generation = (await state.GetActiveAsync(CancellationToken.None))!.TargetGeneration;

        BinaryEndpoints.CategoryMutationReceipt repeated = await BinaryEndpoints.DeleteCategoryAndDispatchAsync(
            db, invalidation, dispatcher, queue, categoryId, CancellationToken.None);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.NotFound, repeated.Outcome);
        Assert.Null(repeated.Delivery);
        Assert.Empty(repeated.MutationId);
        Assert.Equal(generation, (await state.GetActiveAsync(CancellationToken.None))!.TargetGeneration);
        Assert.Single(dispatcher.ReceivedCalls());
    }

    [Fact]
    public async Task LinkedCategoryCleanup_PreservesDataWithoutDispatch()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        int categoryId = await BinaryEndpoints.CreateCategoryAsync(db, "linked", null, CancellationToken.None);
        await db.Ado.ExecuteCommandAsync("INSERT INTO article(CategoryId, IsDeleted, status) VALUES (@id, 0, @status)",
            new SugarParameter("@id", categoryId), new SugarParameter("@status", (int)ArticleStatus.Published));

        BinaryEndpoints.CategoryMutationReceipt result = await BinaryEndpoints.DeleteCategoryAndDispatchAsync(
            db, invalidation, dispatcher, CreateQueue(state), categoryId, CancellationToken.None);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.InUse, result.Outcome);
        Assert.Null(result.Delivery);
        Assert.True(await db.Queryable<Category>().AnyAsync(category => category.Id == categoryId));
        Assert.Empty(dispatcher.ReceivedCalls());
        Assert.Null(await state.GetActiveAsync(CancellationToken.None));
    }

    [Fact]
    public async Task PostCommitDispatchFailure_RetainsEntityForCanonicalCleanup()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactUpdateQueue queue = CreateQueue(state);
        dispatcher.InvalidateCategoryTagAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("invalidation-unavailable")));

        BinaryEndpoints.CategoryMutationDispatchException failure =
            await Assert.ThrowsAsync<BinaryEndpoints.CategoryMutationDispatchException>(() =>
                BinaryEndpoints.CreateCategoryAndDispatchAsync(
                    db, invalidation, dispatcher, queue, "interrupted-owned", null, CancellationToken.None));
        BinaryEndpoints.CategoryMutationReceipt committed = failure.CommittedMutation;
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.Created, committed.Outcome);
        Assert.True(committed.CategoryId > 0);
        Assert.Null(committed.Delivery);
        Assert.True(await db.Queryable<Category>().AnyAsync(category => category.Id == committed.CategoryId));
        Assert.Null(await state.GetActiveAsync(CancellationToken.None));

        var recoveredDispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        BinaryEndpoints.CategoryMutationReceipt cleanup = await BinaryEndpoints.DeleteCategoryAndDispatchAsync(
            db, invalidation, recoveredDispatcher, queue, committed.CategoryId, CancellationToken.None);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.Deleted, cleanup.Outcome);
        Assert.NotNull(cleanup.Delivery);
    }

    [Fact]
    public async Task CallerCancellationAfterCommit_DoesNotInterruptInvalidationOrEnqueue()
    {
        using SqlSugarClient db = CreateDatabase();
        using var cancellation = new CancellationTokenSource();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        invalidation.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                cancellation.Cancel();
                return Task.CompletedTask;
            });

        BinaryEndpoints.CategoryMutationReceipt created = await BinaryEndpoints.CreateCategoryAndDispatchAsync(
            db, invalidation, dispatcher, CreateQueue(state), "disconnected-owned", null, cancellation.Token);
        Assert.True(cancellation.IsCancellationRequested);
        Assert.Equal(BinaryEndpoints.CategoryMutationOutcome.Created, created.Outcome);
        Assert.NotNull(created.Delivery);
        await dispatcher.Received(1).InvalidateCategoryTagAsync(created.MutationId, CancellationToken.None);
        Assert.Equal(created.Delivery.Value.ObligationId, (await state.GetActiveAsync(CancellationToken.None))!.ObligationId);
    }

    private static PublicHotArtifactUpdateQueue CreateQueue(InMemoryPublicHotArtifactDeliveryStateStore state)
        => new(Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }), state, state);

    private static SqlSugarClient CreateDatabase()
    {
        var db = new SqlSugarClient(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = "Data Source=:memory:",
            IsAutoCloseConnection = false,
            InitKeyType = InitKeyType.Attribute
        });
        db.CodeFirst.InitTables<Category>();
        db.Ado.ExecuteCommand("CREATE TABLE article(CategoryId INTEGER NOT NULL, IsDeleted INTEGER NOT NULL, status INTEGER NOT NULL)");
        return db;
    }
}
