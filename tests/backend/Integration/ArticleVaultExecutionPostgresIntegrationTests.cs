using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleVaultExecutionPostgresIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly DateTimeOffset s_now = DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_001);

    [Fact]
    public async Task TwoOperationGroup_WhenSecondWriteFails_RollsBackEveryBusinessSideEffectAndRetryAddsNone()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int categoryId, int tagId, long adminId) = await SeedAuthoritiesAsync(db);
        ArticleVaultSealedExecutionBundle bundle = CreateCreateBundle(
            adminId,
            categoryId,
            tagId,
            ["first body\n", "second body\n"],
            rejectSecond: true);
        var store = new PostgresArticleVaultExecutionStore(db, new FixedTimeProvider(s_now));
        await store.SealAsync(bundle);
        ArticleService service = CreateService(db, store, new RejectSecondPublicationValidator());
        var executor = new ArticleVaultSyncPlanExecutor(store, service, service, new FixedTimeProvider(s_now));

        ArticleVaultExecutionResult first = await executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);
        ArticleVaultExecutionResult replay = await executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Failed, first.Outcome);
        Assert.Equal(first.ContentSha256, replay.ContentSha256);
        ArticleVaultGroupResultReceipt failedGroup = Assert.Single(first.Groups);
        Assert.False(failedGroup.Committed);
        Assert.All(failedGroup.Operations, static operation =>
            Assert.Equal(ArticleVaultOperationOutcome.Failed, operation.Outcome));
        VaultSyncPlanGroup plannedGroup = Assert.Single(bundle.Plan.Groups);
        ArticleVaultGroupResultReceipt persistedFailedAttempt = Assert.IsType<ArticleVaultGroupResultReceipt>(
            await store.LoadGroupResultAsync(
                bundle.Plan.SiteIdentity,
                bundle.Plan.VaultIdentity,
                bundle.PlanSha256,
                plannedGroup.GroupIdentity,
                ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, plannedGroup)));
        Assert.False(persistedFailedAttempt.Committed);
        Assert.DoesNotContain(
            persistedFailedAttempt.Operations,
            static operation => operation.Outcome == ArticleVaultOperationOutcome.Executed);
        Assert.Equal(failedGroup.ContentSha256, persistedFailedAttempt.ContentSha256);
        await AssertCountsAsync(
            db,
            articles: 0,
            revisions: 0,
            outbox: 0,
            audits: 0,
            groups: 1,
            results: 1);
    }

    [Fact]
    public async Task CommittedGroup_WhenTerminalWriteCrashes_RetryReplaysLedgerWithoutDuplicateFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int categoryId, int tagId, long adminId) = await SeedAuthoritiesAsync(db);
        ArticleVaultSealedExecutionBundle bundle = CreateCreateBundle(
            adminId,
            categoryId,
            tagId,
            ["committed body\n"],
            rejectSecond: false);
        var durableStore = new PostgresArticleVaultExecutionStore(db, new FixedTimeProvider(s_now));
        await durableStore.SealAsync(bundle);
        ArticleService service = CreateService(db, durableStore, ArticlePublicationValidatorTestFactory.CreateAllowing());
        var countingWriter = new CountingWriter(service);
        var failingStore = new FailFirstTerminalStore(durableStore);
        var executor = new ArticleVaultSyncPlanExecutor(
            failingStore,
            service,
            countingWriter,
            new FixedTimeProvider(s_now));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));
        await AssertCountsAsync(
            db,
            articles: 1,
            revisions: 1,
            outbox: 1,
            audits: 1,
            groups: 1,
            results: 0);
        Article committedArticle = await db.Queryable<Article>().SingleAsync();
        Assert.Equal(ArticleStatus.Draft, committedArticle.Status);

        ArticleVaultExecutionResult recovered = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Completed, recovered.Outcome);
        Assert.Equal(1, countingWriter.ExecutionCount);
        await AssertCountsAsync(
            db,
            articles: 1,
            revisions: 1,
            outbox: 1,
            audits: 1,
            groups: 1,
            results: 1);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand),
            typeof(AdminPrincipal),
            typeof(AuditLog),
            typeof(ArticleVaultExecutionBundleEntity),
            typeof(ArticleVaultGroupResultEntity),
            typeof(ArticleVaultExecutionResultEntity));
        return db;
    }

    [Fact]
    public async Task TwoOperationCommittedGroup_EnlistsEveryActualEventAndReplayDoesNotAllocateAgain()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int categoryId, int tagId, long adminId) = await SeedAuthoritiesAsync(db);
        ArticleVaultSealedExecutionBundle bundle = CreateCreateBundle(
            adminId, categoryId, tagId, ["first source\n", "second source\n"], rejectSecond: false);
        var store = new PostgresArticleVaultExecutionStore(db, new FixedTimeProvider(s_now));
        await store.SealAsync(bundle);
        ArticleService service = CreateService(db, store, ArticlePublicationValidatorTestFactory.CreateAllowing());
        var executor = new ArticleVaultSyncPlanExecutor(store, service, service, new FixedTimeProvider(s_now));

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);
        ArticleVaultExecutionResult replay = await executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Completed, result.Outcome);
        Assert.Equal(result.ContentSha256, replay.ContentSha256);
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(new long[] { 1, 2 }, await db.Queryable<ArticleSourceMutation>()
            .OrderBy(row => row.SourceGeneration).Select(row => row.SourceGeneration).ToArrayAsync());
        Assert.All(await db.Queryable<ArticleSourceSequence>().ToListAsync(),
            row => Assert.Equal(1, row.SourceSequence));
        Assert.Equal(0, await db.Ado.GetIntAsync("""
            SELECT COUNT(*) FROM article_mutation_outbox event
            FULL JOIN article_source_mutation journal ON journal.event_id = event.event_id
            WHERE event.event_id IS NULL OR journal.event_id IS NULL;
            """));
    }

    [Fact]
    public async Task ActualGroup_WaitsForSourceFamilyBeforeItsIdempotencyAdvisoryOrArticleLocks()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int categoryId, int tagId, long adminId) = await SeedAuthoritiesAsync(db);
        ArticleVaultSealedExecutionBundle bundle = CreateCreateBundle(
            adminId, categoryId, tagId, ["lock order source\n"], rejectSecond: false);
        var store = new PostgresArticleVaultExecutionStore(db, new FixedTimeProvider(s_now));
        await store.SealAsync(bundle);
        ArticleService service = CreateService(db, store, ArticlePublicationValidatorTestFactory.CreateAllowing());
        var executor = new ArticleVaultSyncPlanExecutor(store, service, service, new FixedTimeProvider(s_now));
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        blocker.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(blocker);
        Task<ArticleVaultExecutionResult> execution = executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);
        try
        {
            await using var monitor = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
            await monitor.OpenAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var waiter = new NpgsqlCommand("""
                SELECT pid FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
                    AND classid = 1179866444::oid AND objid = 1::oid AND objsubid = 2
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database());
                """, monitor);
            int? pid = null;
            while (!pid.HasValue)
            {
                pid = await waiter.ExecuteScalarAsync(deadline.Token) as int?;
                await Task.Yield();
                deadline.Token.ThrowIfCancellationRequested();
            }
            await using var heldLocks = new NpgsqlCommand("""
                SELECT COUNT(*) FROM pg_locks WHERE pid = @Pid AND granted
                    AND (relation = 'article'::regclass OR locktype = 'advisory');
                """, monitor);
            heldLocks.Parameters.AddWithValue("Pid", pid.Value);
            Assert.Equal(0L, (long)(await heldLocks.ExecuteScalarAsync(deadline.Token))!);
        }
        finally
        {
            blocker.Ado.RollbackTran();
        }
        ArticleVaultExecutionResult result = await execution;
        Assert.Equal(ArticleVaultExecutionOutcome.Completed, result.Outcome);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    private static async Task<(int CategoryId, int TagId, long AdminId)> SeedAuthoritiesAsync(ISqlSugarClient db)
    {
        int categoryId = await db.Insertable(new Category { Name = $"vault-category-{Guid.NewGuid():N}" })
            .ExecuteReturnIdentityAsync();
        int tagId = await db.Insertable(new Tag { Name = $"vault-tag-{Guid.NewGuid():N}" })
            .ExecuteReturnIdentityAsync();
        long adminId = await db.Insertable(new AdminPrincipal
        {
            Handle = $"vault-admin-{Guid.NewGuid():N}",
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = AdminPermissions.ArticleWrite
        }).ExecuteReturnBigIdentityAsync();
        return (categoryId, tagId, adminId);
    }

    private static ArticleService CreateService(
        SqlSugarClient db,
        PostgresArticleVaultExecutionStore vaultStore,
        IArticlePublicationValidator publicationValidator)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var runtimeKeyScope = Substitute.For<IRuntimeKeyScope>();
        runtimeKeyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var auditStore = new AuditLogStore(db, new ConfigurationBuilder().Build());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: runtimeKeyScope,
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: publicationValidator,
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _timeProvider: new FixedTimeProvider(s_now),
            _vaultAuditLogStore: auditStore,
            _vaultExecutionStore: vaultStore,
            _vaultGroupResultStore: vaultStore);
    }

    private static ArticleVaultSealedExecutionBundle CreateCreateBundle(
        long adminId,
        int categoryId,
        int tagId,
        IReadOnlyList<string> contents,
        bool rejectSecond)
    {
        VaultArticleCoordinate absent = Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            false,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            string.Empty));
        ArticleVaultArticleManifest[] articles = contents.Select((content, index) =>
        {
            VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(
                System.Text.Encoding.UTF8.GetBytes(content));
            VaultArticleCoordinate local = Seal(new VaultArticleCoordinate(
                ArticleVaultSchemas.Coordinate,
                ArticleVaultSchemas.Version,
                true,
                false,
                null,
                source,
                DigestB,
                DigestC,
                "draft",
                DigestC,
                string.Empty));
            string portable = $"portable-create-{index}";
            string path = $"articles/create-{index}.md";
            return Seal(new ArticleVaultArticleManifest(
                ArticleVaultSchemas.ArticleManifest,
                ArticleVaultSchemas.Version,
                "site-primary",
                "vault-primary",
                "device-primary",
                portable,
                null,
                new VaultPathProjection(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
                new VaultArticleCoordinates(absent, local, absent),
                new VaultOperationWatermarks(0, null, null, null, null, null, null),
                VaultArticleState.LocalCreated,
                string.Empty));
        }).ToArray();
        ArticleVaultServerObservation[] observations = articles.Select(article => Seal(
            new ArticleVaultServerObservation(
                ArticleVaultPlanSchemas.ServerObservation,
                ArticleVaultPlanSchemas.Version,
                article.SiteIdentity,
                article.VaultIdentity,
                article.DeviceIdentity,
                article.PortableArticleIdentity,
                null,
                absent,
                string.Empty))).ToArray();
        ArticleVaultRootManifest root = SealRoot(articles);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new ArticleVaultPlanRequest(
            root,
            articles,
            observations,
            [new VaultPlanGroupRequest(
                "group-primary",
                articles.Select(static article => article.PortableArticleIdentity).ToArray(),
                [])],
            VaultSyncDirection.Sync,
            1_800_000_000_000,
            1_800_000_060_000,
            CancellationRequested: false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = Assert.IsType<ArticleVaultSyncPlan>(built.Plan);
        ArticleVaultExecutionPayloadItem[] payloadItems = Assert.Single(plan.Groups).Items.Select((operation, index) =>
        {
            var unsigned = new ArticleVaultExecutionPayloadItem(
                operation.OperationIdentity,
                operation.PortableArticleIdentity,
                null,
                rejectSecond && index == 1 ? "reject-second" : $"create-{index}",
                contents[index],
                "summary",
                null,
                categoryId,
                [tagId],
                operation.Local.Source!.Sha256,
                operation.Local.MetadataManifestSha256!,
                string.Empty);
            return unsigned with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealPayloadItem(unsigned)
            };
        }).ToArray();
        var unsignedPayload = new ArticleVaultExecutionPayload(
            ArticleVaultExecutionSchemas.Payload,
            ArticleVaultExecutionSchemas.Version,
            payloadItems,
            string.Empty);
        ArticleVaultExecutionPayload payload = unsignedPayload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(unsignedPayload)
        };
        var unsignedBundle = new ArticleVaultSealedExecutionBundle(
            ArticleVaultExecutionSchemas.Bundle,
            ArticleVaultExecutionSchemas.Version,
            plan.PlanCandidateIdentity,
            plan.ContentSha256,
            adminId,
            plan,
            root,
            articles,
            observations,
            payload,
            string.Empty);
        return unsignedBundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(unsignedBundle)
        };
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
    {
        VaultArticleCoordinate unsigned = coordinate with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultArticleManifest Seal(ArticleVaultArticleManifest article)
    {
        ArticleVaultArticleManifest unsigned = article with
        {
            State = ArticleVaultStateMachine.Derive(article),
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultServerObservation Seal(ArticleVaultServerObservation observation)
    {
        ArticleVaultServerObservation unsigned = observation with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultRootManifest SealRoot(IReadOnlyList<ArticleVaultArticleManifest> articles)
    {
        ArticleVaultArticleManifest first = articles[0];
        var unsigned = new ArticleVaultRootManifest(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            first.SiteIdentity,
            first.VaultIdentity,
            first.DeviceIdentity,
            articles.Select(article => new VaultArticleReference(
                article.PortableArticleIdentity,
                $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                article.ContentSha256,
                article.PathProjection.RelativePath)).ToArray(),
            [],
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private static async Task AssertCountsAsync(
        ISqlSugarClient db,
        int articles,
        int revisions,
        int outbox,
        int audits,
        int groups,
        int results)
    {
        Assert.Equal(articles, await db.Queryable<Article>().CountAsync());
        Assert.Equal(revisions, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(outbox, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(outbox, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(outbox == 0 ? (long?)null : outbox,
            await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(audits, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(groups, await db.Queryable<ArticleVaultGroupResultEntity>().CountAsync());
        Assert.Equal(results, await db.Queryable<ArticleVaultExecutionResultEntity>().CountAsync());
    }

    private sealed class RejectSecondPublicationValidator : IArticlePublicationValidator
    {
        public ArticlePublicationValidationResult ValidateContent(
            ArticlePublicationValidationInput input,
            DateTime utcNow)
            => Result(input);

        public Task<ArticlePublicationValidationResult> ValidateAsync(
            ArticlePublicationValidationInput input,
            DateTime utcNow,
            CancellationToken cancellationToken = default)
            => Task.FromResult(Result(input));

        private static ArticlePublicationValidationResult Result(ArticlePublicationValidationInput input)
            => input.Title == "reject-second"
                ? new ArticlePublicationValidationResult(
                    false,
                    false,
                    [new PrepublishIssue("error", "forced_second_failure", "forced second operation failure")])
                : new ArticlePublicationValidationResult(true, true, []);
    }

    private sealed class CountingWriter(IArticleVaultCanonicalGroupWriter inner)
        : IArticleVaultCanonicalGroupWriter
    {
        public int ExecutionCount
        {
            get; private set;
        }

        public async Task<ArticleVaultGroupResultReceipt> ExecuteGroupAsync(
            ArticleVaultSealedExecutionBundle bundle,
            VaultSyncPlanGroup group,
            IReadOnlyList<ArticleVaultCurrentArticleObservation> expectedCurrent,
            CancellationToken cancellationToken = default)
        {
            ExecutionCount++;
            return await inner.ExecuteGroupAsync(bundle, group, expectedCurrent, cancellationToken);
        }
    }

    private sealed class FailFirstTerminalStore(IArticleVaultExecutionStore inner)
        : IArticleVaultExecutionStore
    {
        private bool _fail = true;

        public Task SealAsync(ArticleVaultSealedExecutionBundle bundle, CancellationToken cancellationToken = default)
            => inner.SealAsync(bundle, cancellationToken);

        public Task<ArticleVaultSealedExecutionBundle?> LoadSealedAsync(
            string planReference,
            string planSha256,
            CancellationToken cancellationToken = default)
            => inner.LoadSealedAsync(planReference, planSha256, cancellationToken);

        public Task<ArticleVaultGroupResultReceipt?> LoadGroupResultAsync(
            string siteIdentity,
            string vaultIdentity,
            string planSha256,
            string groupIdentity,
            string idempotencySha256,
            CancellationToken cancellationToken = default)
            => inner.LoadGroupResultAsync(
                siteIdentity,
                vaultIdentity,
                planSha256,
                groupIdentity,
                idempotencySha256,
                cancellationToken);

        public Task<ArticleVaultExecutionResult?> LoadResultAsync(
            string resultReference,
            CancellationToken cancellationToken = default)
            => inner.LoadResultAsync(resultReference, cancellationToken);

        public Task SaveResultAsync(
            ArticleVaultExecutionResult result,
            CancellationToken cancellationToken = default)
        {
            if (_fail)
            {
                _fail = false;
                throw new InvalidOperationException("simulated process failure before terminal result persistence");
            }
            return inner.SaveResultAsync(result, cancellationToken);
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
