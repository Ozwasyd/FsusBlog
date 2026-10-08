using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
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

        InvalidOperationException publicFailure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            BinaryEndpoints.AwaitCategoryMutationForPublicEndpointAsync(
                Task.FromException<BinaryEndpoints.CategoryMutationReceipt>(failure)));
        Assert.Same(failure.InnerException, publicFailure);

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

    [Fact]
    public async Task PublicEndpointDispatchCancellation_PreservesOriginalErrorSemantics()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var original = new OperationCanceledException("canonical-dispatch-stopped");
        dispatcher.InvalidateCategoryTagAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(original));

        OperationCanceledException observed = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            BinaryEndpoints.AwaitCategoryMutationForPublicEndpointAsync(BinaryEndpoints.CreateCategoryAndDispatchAsync(
                db, invalidation, dispatcher, CreateQueue(state), "cancelled-dispatch-owned", null, CancellationToken.None)));
        Assert.Same(original, observed);
        Assert.Single(await db.Queryable<Category>().ToListAsync());
        Assert.Null(await state.GetActiveAsync(CancellationToken.None));
    }

    private static PublicHotArtifactUpdateQueue CreateQueue(InMemoryPublicHotArtifactDeliveryStateStore state)
        => new(Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }), state, state);

    [Fact]
    public async Task MutationAndCleanup_BindTheirOwnCanonicalPublishedObligationWithoutQualifyingArtifacts()
    {
        using SqlSugarClient db = CreateDatabase();
        var invalidation = Substitute.For<ICacheInvalidationStore>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactUpdateQueue queue = CreateQueue(state);
        IRuntimeKeyScope scope = DeliveryScope();
        BinaryEndpoints.CategoryMutationReceipt mutation = await BinaryEndpoints.CreateCategoryAndDispatchAsync(
            db, invalidation, dispatcher, queue, "delivery-owned-canary", null, CancellationToken.None);

        RuntimeCacheChurnDeliveryObservation pending = await RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            mutation, state, scope, "delivery-run", CancellationToken.None);
        Assert.False(pending.ExactObligationPublished);
        await CompleteDeliveryAsync(state);
        RuntimeCacheChurnDeliveryObservation published = await RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            mutation, state, scope, "delivery-run", CancellationToken.None);
        Assert.True(published.ExactObligationPublished);
        Assert.Equal(mutation.Delivery!.Value.DeliveryGeneration, published.Obligation.PublishedGeneration);
        Assert.Null(published.BusinessEpochBinding);
        Assert.Null(published.CommonGenerationBinding);
        Assert.False(published.CountsAsReleaseFinal);

        BinaryEndpoints.CategoryMutationReceipt cleanup = await BinaryEndpoints.DeleteCategoryAndDispatchAsync(
            db, invalidation, dispatcher, queue, mutation.CategoryId, CancellationToken.None);
        Assert.Equal(PublicHotArtifactDeliveryStatus.PersistedDirty, cleanup.Delivery!.Value.Status);
        await CompleteDeliveryAsync(state);
        RuntimeCacheChurnDeliveryObservation cleanupPublished = await RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            cleanup, state, scope, "delivery-run", CancellationToken.None);
        Assert.True(cleanupPublished.ExactObligationPublished);
        Assert.Equal(mutation.CategoryId, cleanupPublished.Mutation.CategoryId);
        Assert.NotEqual(published.Obligation.ObligationId, cleanupPublished.Obligation.ObligationId);
        Assert.True(cleanupPublished.Obligation.PublishedGeneration > published.Obligation.PublishedGeneration);
        Assert.False(cleanupPublished.CountsAsReleaseFinal);
    }

    [Theory]
    [InlineData("other-obligation")]
    [InlineData("other-target")]
    [InlineData("other-published")]
    [InlineData("retry")]
    [InlineData("terminal")]
    [InlineData("missing-stage")]
    [InlineData("failed-stage")]
    public async Task DeliveryBinding_RejectsSupersededFailedOrIncompletePublication(string fault)
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactEnqueueResult enqueue = await CreateQueue(state).EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-created");
        await CompleteDeliveryAsync(state);
        PublicHotArtifactObligation obligation = (await state.GetActiveAsync(CancellationToken.None))!;
        obligation = fault switch
        {
            "other-obligation" => obligation with { ObligationId = "unrelated" },
            "other-target" => obligation with { TargetGeneration = obligation.TargetGeneration + 1 },
            "other-published" => obligation with { PublishedGeneration = obligation.PublishedGeneration + 1 },
            "retry" => obligation with { AttemptNumber = 2 },
            "terminal" => obligation with { State = PublicHotArtifactObligationState.FailedTerminal },
            "missing-stage" => obligation with { Attempts = obligation.Attempts.Where(attempt => attempt.Stage != PublicHotArtifactAttemptStage.Publish).ToArray() },
            "failed-stage" => obligation with { LastFailureKind = PublicHotArtifactFailureKind.PublishTransient },
            _ => throw new InvalidOperationException("unknown fault")
        };
        var reader = Substitute.For<IPublicHotArtifactObligationStore>();
        reader.GetActiveAsync(Arg.Any<CancellationToken>()).Returns(obligation);
        var mutation = new BinaryEndpoints.CategoryMutationReceipt(
            BinaryEndpoints.CategoryMutationOutcome.Created, 1, "original-business-mutation", enqueue);
        await Assert.ThrowsAsync<InvalidOperationException>(() => RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            mutation, reader, DeliveryScope(), "delivery-run", CancellationToken.None));
    }

    [Fact]
    public async Task DeliveryBinding_RefusesWrongScopeOrUnavailableEnqueueBeforeStoreReads()
    {
        var reader = Substitute.For<IPublicHotArtifactObligationStore>();
        var unavailable = new BinaryEndpoints.CategoryMutationReceipt(
            BinaryEndpoints.CategoryMutationOutcome.Created, 1, "committed-business-mutation", null);
        await Assert.ThrowsAsync<InvalidOperationException>(() => RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            unavailable, reader, DeliveryScope(), "other-run", CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => RuntimeCacheChurnDeliveryBinding.ObserveAsync(
            unavailable, reader, DeliveryScope(), "delivery-run", CancellationToken.None));
        await reader.DidNotReceive().GetActiveAsync(Arg.Any<CancellationToken>());
    }

    private static IRuntimeKeyScope DeliveryScope()
    {
        IRuntimeKeyScope scope = Substitute.For<IRuntimeKeyScope>();
        scope.ScopeToken.Returns("delivery-run");
        return scope;
    }

    private static async Task CompleteDeliveryAsync(InMemoryPublicHotArtifactDeliveryStateStore state)
    {
        PublicHotArtifactObligation obligation = (await state.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
        Assert.NotNull(obligation);
        foreach (PublicHotArtifactAttemptStage stage in new[]
            { PublicHotArtifactAttemptStage.Projector, PublicHotArtifactAttemptStage.Publish, PublicHotArtifactAttemptStage.RevocationCompletion })
        {
            await state.RecordStageSuccessAsync(
                obligation.ObligationId, obligation.AttemptNumber, stage, DateTimeOffset.UtcNow, CancellationToken.None);
        }
        Assert.True(await state.CompletePublishedAsync(
            obligation.ObligationId, obligation.AttemptNumber, obligation.TargetGeneration, CancellationToken.None));
    }

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
