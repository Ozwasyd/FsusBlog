using System.Collections.Frozen;
using System.Diagnostics;
using System.Net;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class DistributedInvalidationTargetConvergenceIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    private const string AppliedState = "applied";
    private const string TerminalFailedState = "terminal-failed";
    private const string BanSubject = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task DualNodeCommentMutation_ChangesOnlyCommentAndStatsTargets()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [1, 2], seedSeo: true, seedCategory: true);
        IReadOnlyList<CachePolicyStorageSnapshot> before = nodes.Target.LocalCache.SnapshotResidency();
        long readyTicks = Stopwatch.GetTimestamp();

        DistributedInvalidationPublishResult published = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.CommentMutation,
                ["comments", "stats"],
                ["article:1:comments"],
                ["public-hot-read"]));
        Assert.NotEqual(DistributedInvalidationPublishStatus.LocalOnly, published.Status);
        await EventuallyAsync(() => InboxState(nodes.Connection) == AppliedState);

        Assert.True(nodes.Target.HotRead.IsReady);
        Assert.True(Stopwatch.GetElapsedTime(readyTicks) < TimeSpan.FromSeconds(5));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetCategory(out _));
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.ArticleDetail);
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.CategoryFrame);
        AssertResidencyUnchanged(before, nodes.Target.LocalCache.SnapshotResidency(), CachePolicyId.SystemSeo);
        Assert.Equal(AppliedState, InboxState(nodes.Connection));
        DistributedInvalidationLocalApplyResult commentReceipt = nodes.Target.LastResult!;
        Assert.False(commentReceipt.FullReconcile);
        Assert.True(commentReceipt.ResolvedTargetCount >= 4);
        Assert.True(commentReceipt.L1InvalidatedPolicyCount > 0);
        Assert.Equal(0, commentReceipt.AotRouteCount);
        Assert.Equal(1, commentReceipt.HotReadFragmentCount);
    }

    [Fact]
    public async Task DualNodeArticleMutation_KeepsUnrelatedHotReadRouteReady()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [1, 2], seedSeo: true, seedCategory: true);
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact beforeTwo));
        byte[] unchanged = beforeTwo.Frame.ToArray();
        await using KestrelHotReadHost kestrel = await KestrelHotReadHost.StartAsync(nodes.Target.HotRead);
        _ = nodes.DrainSourceRedisCommands();
        string[] redisStartupCommands = nodes.DrainTargetRedisCommands();
        Assert.Contains(redisStartupCommands, static command => command is "SUBSCRIBE" or "PSUBSCRIBE");

        HotReadHttpEvidence beforeHttp = await kestrel.GetArticleAsync(2);
        Assert.True(
            beforeHttp.StatusCode == HttpStatusCode.OK,
            $"Kestrel article request failed: status={beforeHttp.StatusCode}; body={System.Text.Encoding.UTF8.GetString(beforeHttp.Body)}");
        Assert.Equal(unchanged, beforeHttp.Body);
        Assert.Equal(beforeTwo.Version.ToString(System.Globalization.CultureInfo.InvariantCulture), beforeHttp.HotReadVersion);
        Assert.Equal(AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture), beforeHttp.FrameVersion);
        Assert.Equal(beforeTwo.ETag, beforeHttp.ETag);
        _ = nodes.DrainSourceRedisCommands();
        _ = nodes.DrainTargetRedisCommands();

        DistributedInvalidationPublishResult published = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["article-list", "hot-articles", "stats"],
                ["article:1"],
                ["article-detail:1", "public-aot", "public-hot-read"]));
        await EventuallyAsync(() => InboxState(nodes.Connection) == AppliedState);
        Assert.Contains("PUBLISH", nodes.DrainSourceRedisCommands());

        Assert.True(nodes.Target.HotRead.IsReady);
        Assert.False(nodes.Target.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(nodes.Target.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact remaining));
        Assert.Equal(unchanged, remaining.Frame.ToArray());
        DistributedInvalidationLocalApplyResult articleReceipt = nodes.Target.LastResult!;
        Assert.False(articleReceipt.FullReconcile);
        Assert.True(articleReceipt.ResolvedTargetCount >= 7);
        Assert.True(articleReceipt.L1InvalidatedPolicyCount > 0);
        Assert.True(articleReceipt.L1InvalidatedEntryCount > 0);
        Assert.Equal(1, articleReceipt.AotRouteCount);
        Assert.True(articleReceipt.HotReadFragmentCount > 0);

        DistributedInvalidationInboxEntity inbox = Assert.IsType<DistributedInvalidationInboxEntity>(ReadInbox(nodes.Connection));
        Assert.Equal(published.EventId, inbox.EventId);
        Assert.Equal("node-b", inbox.TargetNodeId);
        Assert.Equal(AppliedState, inbox.ApplyState);

        _ = nodes.DrainTargetRedisCommands();
        HotReadHttpEvidence afterHttp = await kestrel.GetArticleAsync(2);
        Assert.Equal(HttpStatusCode.OK, afterHttp.StatusCode);
        Assert.Equal(beforeHttp.Body, afterHttp.Body);
        Assert.Equal(beforeHttp.HotReadVersion, afterHttp.HotReadVersion);
        Assert.Equal(beforeHttp.FrameVersion, afterHttp.FrameVersion);
        Assert.Equal(beforeHttp.ETag, afterHttp.ETag);
        Assert.Empty(nodes.DrainTargetRedisCommands());
    }

    [Fact]
    public async Task DualNodeArticleViewProjection_ConvergesWithinFiveSecondsAndSurvivesOutOfOrderReplay()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [42], seedSeo: false, seedCategory: false);
        long started = Stopwatch.GetTimestamp();

        DistributedInvalidationPublishResult published = await nodes.Source.Bus.PublishAsync(
            ViewProjectionRequest(articleId: 42, views: 120));
        Assert.NotEqual(DistributedInvalidationPublishStatus.LocalOnly, published.Status);
        await EventuallyAsync(() => nodes.Target.ArticleDetailViews.Project(42, 100) == 120);
        Assert.True(Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5));

        _ = await nodes.Source.Bus.PublishAsync(ViewProjectionRequest(articleId: 42, views: 110));
        await EventuallyAsync(() => nodes.Target.ApplierCount >= 2);

        Assert.Equal(120, nodes.Target.ArticleDetailViews.Project(42, 100));
        Assert.True(nodes.Target.TryGetL1(CachePolicyId.ArticleDetail, "42"));
        Assert.Equal(AppliedState, InboxState(nodes.Connection));
        Assert.Equal(0, nodes.Target.LastResult!.L1InvalidatedEntryCount);
        Assert.False(nodes.Target.LastResult.FullReconcile);
    }

    [Fact]
    public async Task BanMutation_CommitSurvivesSkippedPublishAndRestartReplaysThroughRealPostgresAndRedis()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "ban-crash-replay");
        await nodes.Target.Bus.StopAsync(CancellationToken.None);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int accountId = await db.Insertable(new User
        {
            AccountSubjectHash = BanSubject,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = BanStateProjectionFacts.NormalStatus,
            BanStateGeneration = 1
        }).ExecuteReturnIdentityAsync();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        publisher.PublishPreparedAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException<DistributedInvalidationPublishResult>(
                new InvalidOperationException("simulated-process-exit-before-publish")));
        BanStateProjection sourceProjection = new(new MissingBanStateProjectionSource());
        BanStateProjectionRuntimeState runtime = new();
        IBanStateProjectionObligationCoordinator obligations = CreateBanObligationCoordinator(
            db,
            nodes,
            publisher,
            sourceProjection,
            runtime);
        var service = new BlacklistService(
            db,
            Substitute.For<IAccountStateProjectionMutationPublisher>(),
            sourceProjection,
            obligations);

        await service.BanUserAsync(accountId, "policy");

        User committed = await db.Queryable<User>().InSingleAsync(accountId);
        Assert.Equal(BanStateProjectionFacts.BannedStatus, committed.Status);
        Assert.Equal(2, committed.BanStateGeneration);
        Assert.Equal(BanStateProjectionStatus.Banned, sourceProjection.Read(BanSubject).Status);
        Assert.Equal(1, runtime.Snapshot().DurablePublishFailures);
        DistributedInvalidationConvergenceObligationEntity pending = db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.BanStateProjection)
            .Single();
        Assert.NotEqual("complete", pending.State);
        Assert.Equal(0, pending.AttemptCount);

        NodeHarness restartedTarget = NodeHarness.Create(
            "node-b",
            ["node-a", "node-b"],
            nodes.Channel,
            nodes.Prefix,
            nodes.TargetRedis,
            nodes.TargetServices);
        try
        {
            await restartedTarget.PublicAotGeneration.InitializeAsync(CancellationToken.None);
            await restartedTarget.Bus.StartAsync(CancellationToken.None);
            await EventuallyAsync(
                () => restartedTarget.BanStateProjection.Read(BanSubject).Status
                    == BanStateProjectionStatus.Banned);
            await EventuallyAsync(() => BanProjectionIsDurablyComplete(nodes.Connection));
            Assert.Equal(2, restartedTarget.BanStateProjection.Read(BanSubject).Generation);
        }
        finally
        {
            await restartedTarget.Bus.StopAsync(CancellationToken.None);
            restartedTarget.Dispose();
        }
    }

    [Fact]
    public async Task BanProjection_RealRedisDualNodeRejectsOutOfOrderAndDuplicateDeliveries()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "ban-ordering");
        BanStateProjectionUpdate[] updates =
        [
            new(BanSubject, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 3),
            new(BanSubject, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 1),
            new(BanSubject, BanStateProjectionStatus.Normal, null, 2),
            new(BanSubject, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 3)
        ];

        foreach (BanStateProjectionUpdate update in updates)
        {
            _ = await nodes.Source.Bus.PublishAsync(BanProjectionRequest(update));
        }
        await EventuallyAsync(() => nodes.Target.ApplierCount >= updates.Length);

        BanStateProjectionLookup target = nodes.Target.BanStateProjection.Read(BanSubject);
        Assert.Equal(BanStateProjectionStatus.Banned, target.Status);
        Assert.Equal(3, target.Generation);
        Assert.True(nodes.Target.BanStateProjection.Snapshot().StaleUpdates >= 2);
        Assert.True(nodes.Target.BanStateProjection.Snapshot().DuplicateUpdates >= 1);
        Assert.Contains("PUBLISH", nodes.DrainSourceRedisCommands());
    }

    [Fact]
    public async Task AccountStateMutation_LostPubSubAndTargetRestart_ReplaysPostgresLedgerWithoutLegacyRedisReads()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "account-state-replay");
        await nodes.Target.Bus.StopAsync(CancellationToken.None);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int accountId = await db.Insertable(new User
        {
            AccountSubjectHash = BanSubject,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = BanStateProjectionFacts.NormalStatus,
            MfaEnabled = false
        }).ExecuteReturnIdentityAsync();

        AccountStateReadResult sourceBefore = await nodes.Source.AccountStates.ReadAsync(accountId, BanSubject);
        Assert.Equal(AccountStateReadOutcome.Present, sourceBefore.Outcome);
        Assert.False(sourceBefore.Snapshot!.MfaEnabled);

        NodeHarness restartedTarget = NodeHarness.Create(
            "node-b",
            ["node-a", "node-b"],
            nodes.Channel,
            nodes.Prefix,
            nodes.TargetRedis,
            nodes.TargetServices);
        try
        {
            AccountStateReadResult targetBefore = await restartedTarget.AccountStates.ReadAsync(accountId, BanSubject);
            Assert.Equal(AccountStateReadOutcome.Present, targetBefore.Outcome);
            Assert.False(targetBefore.Snapshot!.MfaEnabled);
            _ = nodes.DrainTargetRedisCommands();

            Assert.Equal(
                1,
                await db.Updateable<User>()
                    .SetColumns(user => user.MfaEnabled == true)
                    .Where(user => user.Id == accountId)
                    .ExecuteCommandAsync());

            var runtime = new AccountStateProjectionRuntimeState();
            using var telemetry = new AccountStateProjectionTelemetry(nodes.Source.AccountStates, runtime);
            var publisher = new AccountStateProjectionMutationPublisher(
                nodes.Source.AccountStates,
                nodes.Source.Bus,
                runtime,
                telemetry,
                TimeProvider.System);
            await publisher.ProjectCommittedMutationAsync(accountId);

            AccountStateReadResult sourceAfter = await nodes.Source.AccountStates.ReadAsync(accountId, BanSubject);
            Assert.Equal(AccountStateReadOutcome.Present, sourceAfter.Outcome);
            Assert.True(sourceAfter.Snapshot!.MfaEnabled);
            Assert.Equal(1, runtime.Snapshot().DurablePublishFailures);

            await restartedTarget.Bus.StartAsync(CancellationToken.None);
            await EventuallyAsync(async () =>
            {
                AccountStateReadResult targetAfter = await restartedTarget.AccountStates.ReadAsync(accountId, BanSubject);
                return targetAfter.Outcome == AccountStateReadOutcome.Present
                    && targetAfter.Snapshot?.MfaEnabled == true;
            });
            await EventuallyAsync(() => AccountStateProjectionIsDurablyComplete(nodes.Connection));
            Assert.True(restartedTarget.ApplierCount >= 1);

            string[] restartRedisCommands = nodes.DrainTargetRedisCommands();
            Assert.DoesNotContain(restartRedisCommands, static command => command is "GET" or "MGET");

            long sourceLoadsBeforeMismatch = restartedTarget.AccountStates.Snapshot().SourceLoads;
            AccountStateReadResult mismatch = await restartedTarget.AccountStates.ReadAsync(
                accountId,
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
            Assert.Equal(AccountStateReadOutcome.SubjectMismatch, mismatch.Outcome);
            Assert.Equal(sourceLoadsBeforeMismatch, restartedTarget.AccountStates.Snapshot().SourceLoads);
        }
        finally
        {
            await restartedTarget.Bus.StopAsync(CancellationToken.None);
            restartedTarget.Dispose();
        }
    }

    [Fact]
    public async Task BanProjection_UnknownAuthorityMismatchAndRealPostgresFailureRemainUnknown()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "ban-unknown");
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int accountId = await db.Insertable(new User
        {
            AccountSubjectHash = BanSubject,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = BanStateProjectionFacts.NormalStatus,
            BanStateGeneration = 1
        }).ExecuteReturnIdentityAsync();
        var source = new SqlBanStateProjectionSource(
            nodes.SourceServices.GetRequiredService<IServiceScopeFactory>());
        var projection = new BanStateProjection(source);

        BanStateProjectionLookup mismatch = await projection.GetAsync(
            accountId,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        Assert.Equal(BanStateProjectionStatus.Unknown, mismatch.Status);

        var invalidConnection = new NpgsqlConnectionStringBuilder(nodes.Connection)
        {
            Port = 1,
            Timeout = 1,
            CommandTimeout = 1
        };
        await using ServiceProvider failedDb = new ServiceCollection()
            .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(invalidConnection.ConnectionString))
            .BuildServiceProvider();
        var failedProjection = new BanStateProjection(new SqlBanStateProjectionSource(
            failedDb.GetRequiredService<IServiceScopeFactory>()));

        await Assert.ThrowsAnyAsync<Exception>(
            () => failedProjection.GetAsync(accountId, BanSubject).AsTask());
        Assert.Equal(BanStateProjectionStatus.Unknown, failedProjection.Read(BanSubject).Status);
    }

    [Fact]
    public async Task ArticleViewWriteBuffer_RealPostgresPersistencePublishesDurableDualNodeProjection()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "view-buffer");
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article));
        int articleId = await db.Insertable(new Article
        {
            Title = "view projection",
            CategoryId = 1,
            Views = 100,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();
        nodes.SeedBoth(articles: [articleId], seedSeo: false, seedCategory: false);
        var obligationStore = new DistributedInvalidationConvergenceObligationStore(
            db,
            TimeProvider.System,
            new DistributedInvalidationConvergenceRuntimeState());
        var distributedOptions = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "node-a",
            Channel = nodes.Channel,
            Topology = DistributedInvalidationTopologyManifest.Create(nodes.Channel, ["node-a", "node-b"])
        };
        var obligationCoordinator = new ArticleViewProjectionObligationCoordinator(
            new DistributedInvalidationEventFactory(
                distributedOptions,
                new PrefixRuntimeKeyScope(nodes.Prefix),
                TimeProvider.System),
            distributedOptions,
            obligationStore,
            nodes.Source.Bus);
        var dispatcher = new CacheInvalidationDispatcher(
            Substitute.For<ICacheCounterStore>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: nodes.Source.Bus,
            distributedInvalidationObligations: obligationStore);
        var articleService = new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(nodes.SourceRedis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: new PrefixRuntimeKeyScope(nodes.Prefix),
            _httpContextAccessor: new HttpContextAccessor(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: dispatcher,
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _articleDetailViewProjection: nodes.Source.ArticleDetailViews,
            _articleViewProjectionObligations: obligationCoordinator);
        var hotStats = Substitute.For<IHotStatsInvalidationCoalescer>();
        hotStats.MarkStatsDirtyAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        hotStats.MarkHotArticlesDirtyAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
            new InMemoryPublicHotArtifactDeliveryStateStore());
        var sink = new ArticleServiceViewFlushSink(
            new ArticleCoreService((IArticleCoreGateway)articleService),
            hotStats,
            queue,
            NullLogger<ArticleServiceViewFlushSink>.Instance);
        await using ServiceProvider services = new ServiceCollection()
            .AddSingleton<IArticleViewFlushSink>(sink)
            .BuildServiceProvider();
        var buffer = new ArticleViewWriteBuffer(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ArticleViewWriteBuffer>.Instance);
        long started = Stopwatch.GetTimestamp();

        await buffer.EnqueueAsync(articleId, 7);
        ArticleViewFlushResult flushed = await buffer.FlushAsync();

        Assert.Equal(7, flushed.AcceptedDelta);
        Assert.Equal(new HashSet<int> { articleId }, flushed.UpdatedArticleIds);
        Assert.Equal(107, await db.Queryable<Article>().Where(article => article.Id == articleId).Select(article => article.Views).SingleAsync());
        Assert.Equal(107, nodes.Source.ArticleDetailViews.Project(articleId, 100));
        await EventuallyAsync(() => nodes.Target.ArticleDetailViews.Project(articleId, 100) == 107);
        Assert.True(Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5));
        await EventuallyAsync(() => ViewProjectionIsDurablyComplete(nodes.Connection));
        Assert.Equal(107, nodes.Target.ArticleDetailViews.Project(articleId, 100));
        Assert.Equal(1, db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.ArticleViewProjection)
            .Count());
    }

    [Fact]
    public async Task ArticleViewProjection_PrepareFailureRollsBackViewsAndLedgerInSamePostgresTransaction()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "view-prepare-rollback");
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article));
        int articleId = await InsertArticleAsync(db, 100);
        IArticleViewProjectionObligationCoordinator durable = CreateViewObligationCoordinator(db, nodes, nodes.Source.Bus);
        var service = CreateViewArticleService(
            db,
            nodes,
            new PrepareThenThrowCoordinator(durable),
            new ArticleDetailViewProjection());

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.IncreaseViewCountsAsync(new Dictionary<int, int> { [articleId] = 7 }).AsTask());

        Assert.Equal(100, await db.Queryable<Article>()
            .Where(article => article.Id == articleId)
            .Select(article => article.Views)
            .SingleAsync());
        Assert.Equal(0, db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.ArticleViewProjection)
            .Count());
    }

    [Fact]
    public async Task ArticleViewProjection_CommitSurvivesSkippedPublishAndFreshBusReplaysDurableEvent()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "view-crash-replay");
        await nodes.Target.Bus.StopAsync(CancellationToken.None);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(nodes.Connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article));
        int articleId = await InsertArticleAsync(db, 100);
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        publisher.PublishPreparedAsync(Arg.Any<DistributedInvalidationEvent>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<DistributedInvalidationPublishResult>(
                new InvalidOperationException("simulated-process-exit-before-publish")));
        IArticleViewProjectionObligationCoordinator durable = CreateViewObligationCoordinator(db, nodes, publisher);
        var service = CreateViewArticleService(db, nodes, durable, nodes.Source.ArticleDetailViews);

        IReadOnlySet<int> updated = await service.IncreaseViewCountsAsync(
            new Dictionary<int, int> { [articleId] = 7 });

        Assert.Contains(articleId, updated);
        Assert.Equal(107, await db.Queryable<Article>()
            .Where(article => article.Id == articleId)
            .Select(article => article.Views)
            .SingleAsync());
        DistributedInvalidationConvergenceObligationEntity pending = db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.ArticleViewProjection)
            .Single();
        Assert.Equal("partially-acked", pending.State);
        Assert.Equal(0, pending.AttemptCount);

        NodeHarness restartedTarget = NodeHarness.Create(
            "node-b",
            ["node-a", "node-b"],
            nodes.Channel,
            nodes.Prefix,
            nodes.TargetRedis,
            nodes.TargetServices);
        try
        {
            restartedTarget.Seed([articleId], seedSeo: false, seedCategory: false);
            await restartedTarget.PublicAotGeneration.InitializeAsync(CancellationToken.None);
            await restartedTarget.Bus.StartAsync(CancellationToken.None);
            await EventuallyAsync(() => restartedTarget.ArticleDetailViews.Project(articleId, 100) == 107);
            await EventuallyAsync(() => ViewProjectionIsDurablyComplete(nodes.Connection));
            Assert.Equal(107, restartedTarget.ArticleDetailViews.Project(articleId, 100));
        }
        finally
        {
            await restartedTarget.Bus.StopAsync(CancellationToken.None);
            restartedTarget.Dispose();
        }
    }

    [Fact]
    public async Task SitemapTaxonomyGeneration_DurableDualNodeLostPubSubRestartAndOutOfOrderReplayRejectOldArtifacts()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis, "sitemap");
        var sourceSitemap = new SitemapArtifactCache(nodes.Source.PublicAotGeneration);
        var targetSitemap = new SitemapArtifactCache(nodes.Target.PublicAotGeneration);
        SitemapArtifactSet sourceOld = await sourceSitemap.GetOrBuildAsync(
            _ => Task.FromResult(SitemapBuild("source-old")),
            CancellationToken.None);
        SitemapArtifactSet targetOld = await targetSitemap.GetOrBuildAsync(
            _ => Task.FromResult(SitemapBuild("target-old")),
            CancellationToken.None);
        using IServiceScope obligationScope = nodes.SourceServices.CreateScope();
        var obligationStore = Assert.IsAssignableFrom<IDistributedInvalidationObligationStore>(
            obligationScope.ServiceProvider.GetRequiredService<IDistributedInvalidationDeliveryLedger>());
        var dispatcher = new CacheInvalidationDispatcher(
            Substitute.For<ICacheCounterStore>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: nodes.Source.Bus,
            distributedInvalidationObligations: obligationStore,
            publicAotInvalidationTracker: nodes.Source.PublicAotGeneration);

        await dispatcher.InvalidateCategoryTagAsync();
        long firstGeneration = nodes.Source.PublicAotGeneration.GetSitemapGeneration();
        await EventuallyAsync(() => nodes.Target.PublicAotGeneration.GetSitemapGeneration() == firstGeneration);
        await EventuallyAsync(() => TaxonomyGenerationIsDurablyComplete(nodes.Connection, firstGeneration));
        SitemapArtifactSet sourceCurrent = await sourceSitemap.GetOrBuildAsync(
            _ => Task.FromResult(SitemapBuild("source-current")),
            CancellationToken.None);
        SitemapArtifactSet targetCurrent = await targetSitemap.GetOrBuildAsync(
            _ => Task.FromResult(SitemapBuild("target-current")),
            CancellationToken.None);

        Assert.Equal(firstGeneration, sourceCurrent.Generation);
        Assert.Equal(firstGeneration, targetCurrent.Generation);
        Assert.NotEqual(sourceOld.RootDocument, sourceCurrent.RootDocument);
        Assert.NotEqual(targetOld.RootDocument, targetCurrent.RootDocument);
        Assert.All(sourceCurrent.PageDocuments, page => Assert.Contains("source-current", page, StringComparison.Ordinal));
        Assert.All(targetCurrent.PageDocuments, page => Assert.Contains("target-current", page, StringComparison.Ordinal));

        DistributedInvalidationConvergenceObligationEntity firstObligation = ReadLatestTaxonomyObligation(nodes.Connection);
        Assert.False(string.IsNullOrWhiteSpace(firstObligation.PayloadJson));

        await dispatcher.InvalidateCategoryTagAsync();
        long secondGeneration = nodes.Source.PublicAotGeneration.GetSitemapGeneration();
        await EventuallyAsync(() => nodes.Target.PublicAotGeneration.GetSitemapGeneration() == secondGeneration);
        await EventuallyAsync(() => TaxonomyGenerationIsDurablyComplete(nodes.Connection, secondGeneration));
        RedisChannel channel = RedisChannel.Literal($"{nodes.Prefix}{nodes.Channel}");
        _ = await nodes.SourceRedis.GetSubscriber().PublishAsync(
            channel,
            firstObligation.PayloadJson,
            CommandFlags.DemandMaster);
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        Assert.Equal(secondGeneration, nodes.Target.PublicAotGeneration.GetSitemapGeneration());

        await nodes.TargetRedis.GetSubscriber().UnsubscribeAsync(channel);
        await dispatcher.InvalidateCategoryTagAsync();
        long replayGeneration = nodes.Source.PublicAotGeneration.GetSitemapGeneration();
        await EventuallyAsync(() => nodes.Target.PublicAotGeneration.GetSitemapGeneration() == replayGeneration);
        await EventuallyAsync(() => TaxonomyGenerationIsDurablyComplete(nodes.Connection, replayGeneration));

        var restarted = new PublicAotInvalidationTracker(
            new RedisPublicAotInvalidationGenerationAuthority(
                RedisOperationExecutor.ForTestConnection(nodes.TargetRedis),
                new PrefixRuntimeKeyScope(nodes.Prefix),
                Substitute.For<IPublicAotInvalidationGenerationBootstrapGuard>()));
        await restarted.InitializeAsync(CancellationToken.None);
        var restartedSitemap = new SitemapArtifactCache(restarted);
        SitemapArtifactSet restartedArtifact = await restartedSitemap.GetOrBuildAsync(
            _ => Task.FromResult(SitemapBuild("restarted-current")),
            CancellationToken.None);

        Assert.True(replayGeneration > secondGeneration);
        Assert.Equal(replayGeneration, restartedArtifact.Generation);
        Assert.NotEqual(targetCurrent.RootDocument, restartedArtifact.RootDocument);
    }

    private static SitemapArtifactBuildResult SitemapBuild(string identity)
        => new(
            new SitemapArtifactSet(
                $"root:{identity}",
                [$"page:{identity}:1", $"page:{identity}:2"]),
            AllocationBytes: 1);

    [Fact]
    public async Task LostPubSub_ReplayMatchesOnlineExactTargets()
    {
        await using NodePair online = await NodePair.CreateAsync(postgres, redis, "online");
        await using NodePair replay = await NodePair.CreateAsync(postgres, redis, "replay");
        online.SeedBoth(articles: [4, 5], seedSeo: true, seedCategory: true);
        replay.SeedBoth(articles: [4, 5], seedSeo: true, seedCategory: true);
        _ = await online.Source.Bus.PublishAsync(CommentRequest());
        await EventuallyAsync(() => InboxState(online.Connection) == AppliedState);

        RedisChannel channel = RedisChannel.Literal($"{replay.Prefix}{replay.Channel}");
        await replay.TargetRedis.GetSubscriber().UnsubscribeAsync(channel);
        _ = await replay.Source.Bus.PublishAsync(CommentRequest());
        await EventuallyAsync(() => InboxState(replay.Connection) == AppliedState);

        AssertResidencyEqual(
            online.Target.LocalCache.SnapshotResidency(),
            replay.Target.LocalCache.SnapshotResidency());
        Assert.Equal(online.Target.HotRead.IsReady, replay.Target.HotRead.IsReady);
        Assert.Equal(
            online.Target.HotRead.Current.TryGetArticle(4, out _),
            replay.Target.HotRead.Current.TryGetArticle(4, out _));
        Assert.False(online.Target.LastResult!.FullReconcile);
        Assert.False(replay.Target.LastResult!.FullReconcile);
    }

    [Fact]
    public async Task UnknownTarget_RecordsFullReconcileOnRemoteInbox()
    {
        await using NodePair nodes = await NodePair.CreateAsync(postgres, redis);
        nodes.SeedBoth(articles: [8], seedSeo: true, seedCategory: true);

        _ = await nodes.Source.Bus.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["unknown-target"],
                ["article:8"],
                ["public-aot"]));
        await EventuallyAsync(() => InboxState(nodes.Connection) == TerminalFailedState);

        Assert.False(nodes.Target.HotRead.IsReady);
        Assert.True(nodes.Target.LastResult!.FullReconcile);
    }

    private static string InboxState(string connection)
        => ReadInbox(connection)?.ApplyState ?? string.Empty;

    private static bool ViewProjectionIsDurablyComplete(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        DistributedInvalidationConvergenceObligationEntity? obligation = db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.ArticleViewProjection)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .First();
        if (obligation?.State != "complete")
        {
            return false;
        }

        return db.Queryable<DistributedInvalidationInboxEntity>()
            .Where(item => item.EventId == obligation.EventId
                && item.TargetNodeId == "node-b"
                && item.ApplyState == AppliedState)
            .Any();
    }

    private static bool TaxonomyGenerationIsDurablyComplete(string connection, long generation)
    {
        DistributedInvalidationConvergenceObligationEntity obligation = ReadLatestTaxonomyObligation(connection);
        if (obligation.State != "complete")
        {
            return false;
        }

        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        return db.Queryable<DistributedInvalidationInboxEntity>()
            .Where(item => item.EventId == obligation.EventId
                && item.TargetNodeId == "node-b"
                && item.ApplyState == AppliedState
                && item.AppliedGeneration == generation)
            .Any();
    }

    private static DistributedInvalidationConvergenceObligationEntity ReadLatestTaxonomyObligation(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        return db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.TaxonomyMutation)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .First();
    }

    private static DistributedInvalidationInboxEntity? ReadInbox(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        DistributedInvalidationInboxEntity? inbox = db.Queryable<DistributedInvalidationInboxEntity>().First();
        return inbox;
    }

    private static DistributedInvalidationRequest CommentRequest()
        => new(
            DistributedInvalidationEventKinds.CommentMutation,
            ["comments", "stats"],
            ["article:4:comments"],
            ["public-hot-read"]);

    private static DistributedInvalidationRequest ViewProjectionRequest(int articleId, int views)
        => new(
            DistributedInvalidationEventKinds.ArticleViewProjection,
            [],
            [],
            [DistributedInvalidationTargetResolver.FormatArticleViewProjectionTarget(articleId, views, views)]);

    private static DistributedInvalidationRequest BanProjectionRequest(BanStateProjectionUpdate update)
        => new(
            DistributedInvalidationEventKinds.BanStateProjection,
            [],
            [],
            [DistributedInvalidationTargetResolver.FormatBanStateProjectionTarget(update)]);

    private static async Task<int> InsertArticleAsync(SqlSugarClient db, int views)
        => await db.Insertable(new Article
        {
            Title = "view projection",
            CategoryId = 1,
            Views = views,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();

    private static DistributedInvalidationOptions CreateViewDistributedOptions(NodePair nodes)
        => new()
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "node-a",
            Channel = nodes.Channel,
            Topology = DistributedInvalidationTopologyManifest.Create(nodes.Channel, ["node-a", "node-b"])
        };

    private static IArticleViewProjectionObligationCoordinator CreateViewObligationCoordinator(
        SqlSugarClient db,
        NodePair nodes,
        IDistributedInvalidationPublisher publisher)
    {
        DistributedInvalidationOptions options = CreateViewDistributedOptions(nodes);
        return new ArticleViewProjectionObligationCoordinator(
            new DistributedInvalidationEventFactory(
                options,
                new PrefixRuntimeKeyScope(nodes.Prefix),
                TimeProvider.System),
            options,
            new DistributedInvalidationConvergenceObligationStore(
                db,
                TimeProvider.System,
                new DistributedInvalidationConvergenceRuntimeState()),
            publisher);
    }

    private static IBanStateProjectionObligationCoordinator CreateBanObligationCoordinator(
        SqlSugarClient db,
        NodePair nodes,
        IDistributedInvalidationPublisher publisher,
        BanStateProjection projection,
        BanStateProjectionRuntimeState runtime)
    {
        DistributedInvalidationOptions options = CreateViewDistributedOptions(nodes);
        return new BanStateProjectionObligationCoordinator(
            new DistributedInvalidationEventFactory(
                options,
                new PrefixRuntimeKeyScope(nodes.Prefix),
                TimeProvider.System),
            options,
            new DistributedInvalidationConvergenceObligationStore(
                db,
                TimeProvider.System,
                new DistributedInvalidationConvergenceRuntimeState()),
            publisher,
            projection,
            runtime);
    }

    private static bool BanProjectionIsDurablyComplete(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        DistributedInvalidationConvergenceObligationEntity? obligation = db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.BanStateProjection)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .First();
        return obligation?.State == "complete";
    }

    private static bool AccountStateProjectionIsDurablyComplete(string connection)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        DistributedInvalidationConvergenceObligationEntity? obligation = db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.Kind == DistributedInvalidationEventKinds.AccountStateProjectionMutation)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .First();
        return obligation?.State == "complete"
            && db.Queryable<DistributedInvalidationInboxEntity>()
                .Where(item => item.EventId == obligation.EventId
                    && item.TargetNodeId == "node-b"
                    && item.ApplyState == AppliedState)
                .Any();
    }

    private static ArticleService CreateViewArticleService(
        SqlSugarClient db,
        NodePair nodes,
        IArticleViewProjectionObligationCoordinator obligations,
        IArticleDetailViewProjection projection)
        => new(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(nodes.SourceRedis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: new PrefixRuntimeKeyScope(nodes.Prefix),
            _httpContextAccessor: new HttpContextAccessor(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _articleDetailViewProjection: projection,
            _articleViewProjectionObligations: obligations);

    private static void AssertResidencyUnchanged(
        IReadOnlyList<CachePolicyStorageSnapshot> before,
        IReadOnlyList<CachePolicyStorageSnapshot> after,
        CachePolicyId policyId)
    {
        CachePolicyStorageSnapshot previous = before.Single(item => item.PolicyId == policyId);
        CachePolicyStorageSnapshot current = after.Single(item => item.PolicyId == policyId);
        Assert.Equal(previous.KeyCount, current.KeyCount);
        Assert.Equal(previous.Bytes, current.Bytes);
    }

    private static void AssertResidencyEqual(
        IReadOnlyList<CachePolicyStorageSnapshot> left,
        IReadOnlyList<CachePolicyStorageSnapshot> right)
    {
        Assert.Equal(left.Count, right.Count);
        for (int i = 0; i < left.Count; i++)
        {
            Assert.Equal(left[i].PolicyId, right[i].PolicyId);
            Assert.Equal(left[i].KeyCount, right[i].KeyCount);
            Assert.Equal(left[i].Bytes, right[i].Bytes);
        }
    }

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate())
        {
            await Task.Delay(25, timeout.Token);
        }
    }

    private static async Task EventuallyAsync(Func<Task<bool>> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await predicate().ConfigureAwait(false))
        {
            await Task.Delay(25, timeout.Token);
        }
    }

    private readonly record struct HotReadHttpEvidence(
        HttpStatusCode StatusCode,
        byte[] Body,
        string? HotReadVersion,
        string? FrameVersion,
        string? ETag);

    private sealed class PrepareThenThrowCoordinator(IArticleViewProjectionObligationCoordinator inner)
        : IArticleViewProjectionObligationCoordinator
    {
        public async Task<DistributedInvalidationEvent?> PrepareAsync(
            IReadOnlyDictionary<int, int> authoritativeViews,
            CancellationToken cancellationToken = default)
        {
            _ = await inner.PrepareAsync(authoritativeViews, cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException("simulated-ledger-prepare-failure");
        }

        public Task<DistributedInvalidationPublishResult?> PublishPreparedAsync(
            DistributedInvalidationEvent? invalidation,
            CancellationToken cancellationToken = default)
            => inner.PublishPreparedAsync(invalidation, cancellationToken);
    }

    private sealed class MissingBanStateProjectionSource : IBanStateProjectionSource
    {
        public ValueTask<BanStateProjectionUpdate?> LoadAsync(
            int accountId,
            string accountSubjectHash,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<BanStateProjectionUpdate?>(null);
    }

    private sealed class KestrelHotReadHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly HttpClient _client;

        private KestrelHotReadHost(WebApplication app, HttpClient client)
        {
            _app = app;
            _client = client;
        }

        public static async Task<KestrelHotReadHost> StartAsync(PublicHotReadStore store)
        {
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = Environments.Production
            });
            builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost";
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            builder.Services.AddRouting();
            builder.Services.Configure<PublicHotReadOptions>(options =>
            {
                options.Enabled = true;
                options.FailOpenWhenNotReady = false;
                options.EnableDiagnosticHeaders = true;
            });
            builder.Services
                .AddSingleton(store)
                .AddSingleton<PublicHotReadEarlyDataPlaneRuntimeState>()
                .AddSingleton<PublicHotReadClassifierCounters>()
                .AddSingleton<PublicHotReadCounters>();

            WebApplication app = builder.Build();
            app.UseFsusPublicHotReadClassifier();
            app.UseFsusPublicHotReadFastPath();
            app.Run(static context =>
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            });
            await app.StartAsync().ConfigureAwait(false);

            IServerAddressesFeature addresses = app.Services
                .GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
                .Features
                .Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel did not expose a bound address.");
            HttpClient client = new(new HttpClientHandler
            {
                UseProxy = false
            })
            {
                BaseAddress = new Uri(addresses.Addresses.Single()),
                Timeout = TimeSpan.FromSeconds(10)
            };
            return new KestrelHotReadHost(app, client);
        }

        public async Task<HotReadHttpEvidence> GetArticleAsync(int articleId)
        {
            using HttpRequestMessage request = new(
                HttpMethod.Get,
                $"/api/binary/article/{articleId}.aeds");
            request.Headers.TryAddWithoutValidation("Accept", "application/octet-stream");
            request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
            using HttpResponseMessage response = await _client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(false);
            return new(
                response.StatusCode,
                await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false),
                Header(response, "X-Fsus-HotRead-Version"),
                Header(response, "X-Fsus-Frame-Version"),
                Header(response, "ETag"));
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.StopAsync().ConfigureAwait(false);
            await _app.DisposeAsync().ConfigureAwait(false);
        }

        private static string? Header(HttpResponseMessage response, string name)
            => response.Headers.TryGetValues(name, out IEnumerable<string>? values)
                ? values.SingleOrDefault()
                : null;
    }

    private sealed class NodePair : IAsyncDisposable
    {
        private NodePair(
            string connection,
            string prefix,
            string channel,
            ConnectionMultiplexer sourceRedis,
            ConnectionMultiplexer targetRedis,
            ProfilingSession sourceRedisProfile,
            ProfilingSession targetRedisProfile,
            ServiceProvider sourceServices,
            ServiceProvider targetServices,
            NodeHarness source,
            NodeHarness target)
        {
            Connection = connection;
            Prefix = prefix;
            Channel = channel;
            SourceRedis = sourceRedis;
            TargetRedis = targetRedis;
            _sourceRedisProfile = sourceRedisProfile;
            _targetRedisProfile = targetRedisProfile;
            SourceServices = sourceServices;
            TargetServices = targetServices;
            Source = source;
            Target = target;
        }

        public string Connection
        {
            get;
        }
        public string Prefix
        {
            get;
        }
        public string Channel
        {
            get;
        }
        public ConnectionMultiplexer SourceRedis
        {
            get;
        }
        public ConnectionMultiplexer TargetRedis
        {
            get;
        }
        private readonly ProfilingSession _sourceRedisProfile;
        private readonly ProfilingSession _targetRedisProfile;

        public string[] DrainSourceRedisCommands()
            => _sourceRedisProfile.FinishProfiling().Select(static item => item.Command).ToArray();

        public string[] DrainTargetRedisCommands()
            => _targetRedisProfile.FinishProfiling().Select(static item => item.Command).ToArray();

        public ServiceProvider SourceServices
        {
            get;
        }
        public ServiceProvider TargetServices
        {
            get;
        }
        public NodeHarness Source
        {
            get;
        }
        public NodeHarness Target
        {
            get;
        }

        public static async Task<NodePair> CreateAsync(
            PostgresSchemaMigrationFixture postgres,
            PublicHotDeliveryRedisFixture redis,
            string? label = null)
        {
            string connection = await CreateDatabaseAsync(postgres);
            string prefix = $"test:distributed-target:{label ?? "pair"}:{Guid.CreateVersion7():N}:";
            string channel = $"invalidation-{Guid.CreateVersion7():N}";
            ConnectionMultiplexer sourceRedis = await redis.ConnectAsync();
            ConnectionMultiplexer targetRedis = await redis.ConnectAsync();
            var sourceRedisProfile = new ProfilingSession();
            var targetRedisProfile = new ProfilingSession();
            sourceRedis.RegisterProfiler(() => sourceRedisProfile);
            targetRedis.RegisterProfiler(() => targetRedisProfile);
            ServiceProvider sourceServices = CreateLedgerServices(connection);
            ServiceProvider targetServices = CreateLedgerServices(connection);
            var source = NodeHarness.Create("node-a", ["node-a", "node-b"], channel, prefix, sourceRedis, sourceServices);
            var target = NodeHarness.Create("node-b", ["node-a", "node-b"], channel, prefix, targetRedis, targetServices);
            await source.PublicAotGeneration.InitializeAsync(CancellationToken.None);
            await target.PublicAotGeneration.InitializeAsync(CancellationToken.None);
            await source.Bus.StartAsync(CancellationToken.None);
            await target.Bus.StartAsync(CancellationToken.None);
            await Task.Delay(TimeSpan.FromMilliseconds(150));
            return new(
                connection,
                prefix,
                channel,
                sourceRedis,
                targetRedis,
                sourceRedisProfile,
                targetRedisProfile,
                sourceServices,
                targetServices,
                source,
                target);
        }

        public void SeedBoth(int[] articles, bool seedSeo, bool seedCategory)
        {
            Source.Seed(articles, seedSeo, seedCategory);
            Target.Seed(articles, seedSeo, seedCategory);
        }

        public async ValueTask DisposeAsync()
        {
            await Target.Bus.StopAsync(CancellationToken.None);
            await Source.Bus.StopAsync(CancellationToken.None);
            await SourceServices.DisposeAsync();
            await TargetServices.DisposeAsync();
            await SourceRedis.DisposeAsync();
            await TargetRedis.DisposeAsync();
            Source.Dispose();
            Target.Dispose();
        }

        private static async Task<string> CreateDatabaseAsync(PostgresSchemaMigrationFixture postgres)
        {
            string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(DistributedInvalidationConvergenceObligationEntity),
                typeof(DistributedInvalidationInboxEntity),
                typeof(DistributedInvalidationTopologyRetirementEntity),
                typeof(DistributedInvalidationReconcileCoverageEntity),
                typeof(DistributedInvalidationFullReconcileObligationEntity));
            return connection;
        }

        private static ServiceProvider CreateLedgerServices(string connection)
            => new ServiceCollection()
                .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connection))
                .AddSingleton(TimeProvider.System)
                .AddSingleton<DistributedInvalidationConvergenceRuntimeState>()
                .AddScoped<IDistributedInvalidationDeliveryLedger, DistributedInvalidationConvergenceObligationStore>()
                .BuildServiceProvider();
    }

    private sealed class NodeHarness : IDisposable
    {
        private readonly MemoryCache _memory;
        private readonly CachePolicyRegistry _policies = new();
        private readonly Dictionary<int, byte[]> _articleBytes = [];
        private readonly CountingApplier _counting;

        private NodeHarness(
            MemoryCache memory,
            PolicyShardedCacheL1Store localCache,
            PublicHotReadStore hotRead,
            PublicAotInvalidationTracker publicAotGeneration,
            ArticleDetailViewProjection articleDetailViews,
            BanStateProjection banStateProjection,
            AccountStateProjection accountStates,
            CountingApplier counting,
            DistributedInvalidationBus bus)
        {
            _memory = memory;
            LocalCache = localCache;
            HotRead = hotRead;
            PublicAotGeneration = publicAotGeneration;
            ArticleDetailViews = articleDetailViews;
            BanStateProjection = banStateProjection;
            AccountStates = accountStates;
            _counting = counting;
            Bus = bus;
        }

        public PolicyShardedCacheL1Store LocalCache
        {
            get;
        }
        public PublicHotReadStore HotRead
        {
            get;
        }
        public PublicAotInvalidationTracker PublicAotGeneration
        {
            get;
        }
        public ArticleDetailViewProjection ArticleDetailViews
        {
            get;
        }
        public BanStateProjection BanStateProjection
        {
            get;
        }
        public AccountStateProjection AccountStates
        {
            get;
        }
        public DistributedInvalidationBus Bus
        {
            get;
        }
        public int ApplierCount => _counting.Applied;
        public DistributedInvalidationLocalApplyResult? LastResult => _counting.LastResult;

        public static NodeHarness Create(
            string nodeId,
            IReadOnlyList<string> nodeIds,
            string channel,
            string prefix,
            IConnectionMultiplexer redis,
            ServiceProvider services)
        {
            var memory = new MemoryCache(new MemoryCacheOptions());
            var localCache = new PolicyShardedCacheL1Store(new CachePolicyRegistry(), TimeProvider.System);
            var scope = new PrefixRuntimeKeyScope(prefix);
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.ContentRootPath.Returns(Path.GetTempPath());
            environment.WebRootPath.Returns(Path.GetTempPath());
            var publicAotCache = new PublicAotFileShellCache(
                environment,
                RedisOperationExecutor.ForTestConnection(redis),
                NullLogger<PublicAotFileShellCache>.Instance,
                configuration: new ConfigurationBuilder().Build(),
                publicArtifactStorage: Substitute.For<IPublicArtifactStorage>());
            var hotRead = new PublicHotReadStore();
            var delivery = new InMemoryPublicHotArtifactDeliveryStateStore();
            var queue = new PublicHotArtifactUpdateQueue(
                Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
                delivery,
                delivery);
            var articleDetailViews = new ArticleDetailViewProjection();
            var banStateProjection = new BanStateProjection(new MissingBanStateProjectionSource());
            var accountStates = new AccountStateProjection(
                new SqlAccountStateProjectionSource(
                    services.GetRequiredService<IServiceScopeFactory>(),
                    new AccountStateProjectionRuntimeState()));
            var generationGuard = Substitute.For<IPublicAotInvalidationGenerationBootstrapGuard>();
            var publicAotGeneration = new PublicAotInvalidationTracker(
                new RedisPublicAotInvalidationGenerationAuthority(
                    RedisOperationExecutor.ForTestConnection(redis),
                    scope,
                    generationGuard));
            var inner = new DistributedInvalidationLocalApplier(
                new NodeCacheInvalidator(localCache),
                publicAotCache,
                publicAotGeneration,
                new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
                hotRead,
                queue,
                Substitute.For<IAotSeoConfigSnapshot>(),
                new CacheInvalidationRuntimeState(),
                NullLogger<DistributedInvalidationLocalApplier>.Instance,
                runtimeKeyScope: scope,
                articleDetailViews: articleDetailViews,
                banStateProjection: banStateProjection,
                accountStateProjection: accountStates);
            var counting = new CountingApplier(inner);
            var options = new DistributedInvalidationOptions
            {
                RuntimeMode = RuntimeModeKind.StaticRole,
                NodeId = nodeId,
                Channel = channel,
                Topology = DistributedInvalidationTopologyManifest.Create(channel, nodeIds),
                ApplyRetryCount = 2,
                ApplyRetryDelay = TimeSpan.FromMilliseconds(10),
                RecoveryReplayInterval = TimeSpan.FromMilliseconds(100),
                DedupeCapacity = 128
            };
            var bus = new DistributedInvalidationBus(
                new RedisDistributedInvalidationTransport(
                    RedisOperationExecutor.ForTestConnection(redis),
                    scope,
                    options,
                    TimeProvider.System,
                    services.GetRequiredService<IServiceScopeFactory>()),
                counting,
                new DistributedInvalidationEventFactory(options, scope, TimeProvider.System),
                options,
                new DistributedInvalidationRuntimeState(TimeProvider.System),
                new CacheInvalidationRuntimeState(),
                NullLogger<DistributedInvalidationBus>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            return new NodeHarness(
                memory,
                localCache,
                hotRead,
                publicAotGeneration,
                articleDetailViews,
                banStateProjection,
                accountStates,
                counting,
                bus);
        }

        public void Seed(int[] articles, bool seedSeo, bool seedCategory)
        {
            var encoder = new AedsEncoder();
            var frames = new Dictionary<int, PublicBinaryArtifact>();
            foreach (int articleId in articles)
            {
                byte[] payload = [(byte)articleId];
                _articleBytes[articleId] = payload;
                SeedPolicy(CachePolicyId.ArticleDetail, articleId.ToString(), payload);
                frames[articleId] = new(
                    encoder.Encode(AedsFrameType.ArticleDetail, payload),
                    $"\"{articleId}\"",
                    "public,max-age=60",
                    1,
                    AedsFrameType.ArticleDetail);
            }

            if (seedSeo)
            {
                SeedPolicy(CachePolicyId.SystemSeo, "main", [9]);
            }

            if (seedCategory)
            {
                SeedPolicy(CachePolicyId.CategoryFrame, "all", [8]);
            }

            PublicBinaryArtifact category = seedCategory
                ? new(encoder.Encode(AedsFrameType.CategoryList, [1]), "\"cat\"", "public,max-age=60", 1, AedsFrameType.CategoryList)
                : default;
            HotRead.Publish(new PublicHotReadSnapshot(
                1,
                frames.ToFrozenDictionary(),
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
                category,
                default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow)));
        }

        public byte[] ArticleBytes(int articleId)
            => _articleBytes[articleId];

        public void Dispose()
            => _memory.Dispose();

        public bool TryGetL1(CachePolicyId policyId, string identity)
            => LocalCache.TryGet(CacheL1Key.ForString("default", policyId, identity), out _);

        private void SeedPolicy(CachePolicyId policyId, string identity, byte[] payload)
        {
            Assert.True(_policies.TryGet(policyId, out CachePolicy policy));
            LocalCache.TrySetOwned(
                policy,
                CacheL1Key.ForString("default", policyId, identity),
                policy.BuildKey(identity),
                payload);
        }

        private sealed class NodeCacheInvalidator(PolicyShardedCacheL1Store localStore) : ICacheLocalInvalidator
        {
            public CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
                => localStore.InvalidateLocal(keys);

            public CacheL1InvalidationReceipt ReconcileAllLocal()
                => localStore.ReconcileAllLocal();
        }
    }

    private sealed class CountingApplier(IDistributedInvalidationLocalApplier inner) : IDistributedInvalidationLocalApplier
    {
        public int Applied
        {
            get;
            private set;
        }
        public DistributedInvalidationLocalApplyResult? LastResult
        {
            get;
            private set;
        }

        public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            DistributedInvalidationLocalApplyResult? result = await inner
                .ApplyAsync(invalidation, cancellationToken)
                .ConfigureAwait(false);
            LastResult = result;
            Applied++;
            return result;
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key)
            => string.Concat(prefix, key);
    }
}
