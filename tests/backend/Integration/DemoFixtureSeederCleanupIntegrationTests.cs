using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class DemoFixtureSeederCleanupIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string VariantId = "diagnostic.development.demo.dataset";
    private const string Owner = "demo-fixture:0123456789abcdef01234567";
    private const string OtherOwner = "demo-fixture:89abcdef0123456701234567";
    private const string FixtureSecret = "demo-fixture-cleanup-integration-secret";

    [Fact]
    public async Task CleanupAsync_UsesTransactionLocalBypass_RollsBackAndPreservesNonDemoRows()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DemoFixtureSeeder seeder = CreateSeeder(db, Environments.Development);
        SeededDemo demo = await SeedDemoAsync(db);

        int developerCategory = await db.Insertable(new Category { Name = "developer-category" })
            .ExecuteReturnIdentityAsync();
        int developerArticle = await db.Insertable(new Article
        {
            Title = "developer article",
            CategoryId = developerCategory
        }).ExecuteReturnIdentityAsync();
        const long DeveloperCommentId = 99101;
        await db.Insertable(new Comment
        {
            Id = DeveloperCommentId,
            ArticleId = developerArticle,
            Content = "[demo fixture] developer-owned content",
            CreateTime = DateTime.UtcNow,
            CurrentVersion = 1,
            AuthorMode = "zk_anonymous",
            AnonymousHandle = "developer-reader",
            AnonymousScope = OtherOwner + ":comment-approved",
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommandAsync();
        long developerEvent = await db.Queryable<CommentModerationEvent>()
            .Where(item => item.CommentId == DeveloperCommentId)
            .Select(item => item.Id)
            .SingleAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(() => seeder.CleanupAsync(demo.Receipt.Skip(1).ToArray()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => seeder.CleanupAsync(
            demo.Receipt.Select(item => item with { Owner = OtherOwner }).ToArray()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => seeder.CleanupAsync(
            demo.Receipt.Select(item => item with { VariantId = "diagnostic.development.demo.article" }).ToArray()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => seeder.CleanupAsync(
            demo.Receipt.Select(item => item.Kind == "article" && item.Handle == "public-preview"
                ? item with
                {
                    Id = developerArticle.ToString()
                }
                : item).ToArray()));

        await db.Ado.ExecuteCommandAsync(
            $"""
            CREATE OR REPLACE FUNCTION fsus_test_reject_demo_article_delete()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.title LIKE '{Owner}:%' THEN
                    RAISE EXCEPTION 'forced demo cleanup rollback';
                END IF;
                RETURN OLD;
            END; $$;
            CREATE TRIGGER trg_test_reject_demo_article_delete
            BEFORE DELETE ON article
            FOR EACH ROW EXECUTE FUNCTION fsus_test_reject_demo_article_delete();
            ALTER TABLE article ENABLE ALWAYS TRIGGER trg_test_reject_demo_article_delete;
            """);

        await Assert.ThrowsAnyAsync<Exception>(() => seeder.CleanupAsync(demo.Receipt));
        Assert.Equal("origin", await ReadReplicationRoleAsync(db));
        Assert.Equal(3, await db.Queryable<Article>().Where(item => demo.ArticleIds.Contains(item.Id)).CountAsync());
        Assert.Equal(2, await db.Queryable<Comment>().Where(item => demo.CommentIds.Contains(item.Id)).CountAsync());
        Assert.Equal(2, await db.Queryable<CommentModerationEvent>()
            .Where(item => demo.ModerationEventIds.Contains(item.Id))
            .CountAsync());

        await db.Ado.ExecuteCommandAsync(
            """
            DROP TRIGGER trg_test_reject_demo_article_delete ON article;
            DROP FUNCTION fsus_test_reject_demo_article_delete();
            """);

        await seeder.CleanupAsync(demo.Receipt);

        Assert.Equal("origin", await ReadReplicationRoleAsync(db));
        Assert.Equal(0, await db.Queryable<Article>().Where(item => demo.ArticleIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<Comment>().Where(item => demo.CommentIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<CommentModerationEvent>()
            .Where(item => demo.ModerationEventIds.Contains(item.Id))
            .CountAsync());
        Assert.NotNull(await db.Queryable<Article>().InSingleAsync(developerArticle));
        Assert.NotNull(await db.Queryable<Comment>().InSingleAsync(DeveloperCommentId));
        Assert.NotNull(await db.Queryable<CommentModerationEvent>().InSingleAsync(developerEvent));
    }

    [Fact]
    public async Task CleanupThenPrepare_UsesReceiptAuthorityAfterBusinessFieldsDrift_WithoutDuplicates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DemoFixtureSeeder seeder = CreateSeeder(
            db,
            Environments.Development,
            observeDatabase: true);
        var request = new DemoFixtureRequest("mutable-owner-test", "same-run");

        DemoFixtureResult first = await seeder.PrepareAsync(request);
        Assert.Equal(23, first.EntityIdentities.Count);
        ReceiptIds firstIds = ParseReceiptIds(first.EntityIdentities);

        foreach (int categoryId in firstIds.CategoryIds)
        {
            string name = $"mutated-category-{categoryId}";
            await db.Updateable<Category>()
                .SetColumns(item => item.Name == name)
                .Where(item => item.Id == categoryId)
                .ExecuteCommandAsync();
        }
        foreach (int tagId in firstIds.TagIds)
        {
            string name = $"mutated-tag-{tagId}";
            await db.Updateable<Tag>()
                .SetColumns(item => item.Name == name)
                .Where(item => item.Id == tagId)
                .ExecuteCommandAsync();
        }
        foreach (int articleId in firstIds.ArticleIds)
        {
            string title = $"mutated-title-{articleId}";
            await db.Updateable<Article>()
                .SetColumns(item => item.Title == title)
                .Where(item => item.Id == articleId)
                .ExecuteCommandAsync();
        }
        foreach (long commentId in firstIds.CommentIds)
        {
            string scope = $"mutated-scope-{commentId}";
            await db.Updateable<Comment>()
                .SetColumns(item => item.AnonymousScope == scope)
                .Where(item => item.Id == commentId)
                .ExecuteCommandAsync();
        }
        await db.Updateable<AdminPrincipal>()
            .SetColumns(item => item.Handle == "mutated-admin-handle")
            .Where(item => item.Id == firstIds.AdminPrincipalId)
            .ExecuteCommandAsync();
        await db.Updateable<User>()
            .SetColumns(item => item.PublicHandle == "mutated-reader-handle")
            .Where(item => item.Id == firstIds.UserId)
            .ExecuteCommandAsync();
        await db.Updateable<AuditLog>()
            .SetColumns(item => item.Source == "mutated-audit-source")
            .Where(item => firstIds.AuditIds.Contains(item.Id))
            .ExecuteCommandAsync();
        await db.Insertable(firstIds.CommentIds.Select(commentId => new CommentModerationEvent
        {
            CommentId = commentId,
            EventType = CommentModerationEventTypes.Approve,
            PreviousStatus = CommentModerationStatus.Pending,
            NextStatus = CommentModerationStatus.Approved,
            ActorType = "system",
            TransitionSource = "test-business-field-drift",
            OccurredAtUtc = DateTime.UtcNow
        }).ToArray()).ExecuteCommandAsync();

        await seeder.CleanupAsync(first.EntityIdentities);
        await AssertReceiptRowsAbsentAsync(db, firstIds);
        Assert.Equal(0, await db.Queryable<CommentModerationEvent>()
            .Where(item => firstIds.CommentIds.Contains(item.CommentId))
            .CountAsync());

        DemoFixtureResult second = await seeder.PrepareAsync(request);
        Assert.Equal(23, second.EntityIdentities.Count);
        Assert.Equal(
            23,
            second.EntityIdentities
                .Select(static item => $"{item.Kind}:{item.Id}")
                .Distinct(StringComparer.Ordinal)
                .Count());
        Assert.All(second.EntityIdentities, static item =>
            Assert.Matches("^sha256:[0-9a-f]{64}$", item.Digest));

        ReceiptIds secondIds = ParseReceiptIds(second.EntityIdentities);
        Assert.Empty(firstIds.ArticleIds.Intersect(secondIds.ArticleIds));
        Assert.Equal(3, await db.Queryable<Article>()
            .Where(item => secondIds.ArticleIds.Contains(item.Id))
            .CountAsync());
        Assert.Equal(2, await db.Queryable<Comment>()
            .Where(item => secondIds.CommentIds.Contains(item.Id))
            .CountAsync());
        Assert.Equal(2, await db.Queryable<CommentModerationEvent>()
            .Where(item => secondIds.CommentIds.Contains(item.CommentId))
            .CountAsync());
    }

    [Fact]
    public async Task CleanupAsync_RetriesExternalConvergenceAfterDatabaseCommit()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        SeededDemo demo = await SeedDemoAsync(db);
        IAdminArtifactOperations artifacts = Substitute.For<IAdminArtifactOperations>();
        int searchAttempts = 0;
        artifacts.RunCacheActionAsync(
                Arg.Any<AdminCacheActionRequest>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string action = call.Arg<AdminCacheActionRequest>().Action;
                string status = action switch
                {
                    "search-rebuild" when Interlocked.Increment(ref searchAttempts) == 1 => "failed",
                    "public-hot-rebuild" => "queued",
                    _ => "ok"
                };
                return Task.FromResult(new AdminCacheActionResponse(
                    action,
                    status,
                    "test convergence",
                    DateTimeOffset.UtcNow));
            });
        DemoFixtureSeeder seeder = CreateSeeder(
            db,
            Environments.Development,
            artifacts);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => seeder.CleanupAsync(demo.Receipt));
        ReceiptIds ids = ParseReceiptIds(demo.Receipt);
        await AssertReceiptRowsAbsentAsync(db, ids);
        Assert.Equal("origin", await ReadReplicationRoleAsync(db));

        await seeder.CleanupAsync(demo.Receipt);

        Assert.Equal(2, searchAttempts);
        Assert.Equal("origin", await ReadReplicationRoleAsync(db));
    }

    [Fact]
    public async Task CleanupAsync_RejectsPartialExactReceiptStateWithoutDeletingRemainingRows()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DemoFixtureSeeder seeder = CreateSeeder(db, Environments.Development);
        SeededDemo demo = await SeedDemoAsync(db);
        ReceiptIds ids = ParseReceiptIds(demo.Receipt);
        await db.Deleteable<AuditLog>()
            .Where(item => item.Id == ids.AuditIds[0])
            .ExecuteCommandAsync();

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => seeder.CleanupAsync(demo.Receipt));

        Assert.Contains("partial or mismatched", error.Message, StringComparison.Ordinal);
        Assert.Equal(3, await db.Queryable<Article>()
            .Where(item => ids.ArticleIds.Contains(item.Id))
            .CountAsync());
        Assert.Equal(2, await db.Queryable<Comment>()
            .Where(item => ids.CommentIds.Contains(item.Id))
            .CountAsync());
        Assert.Equal("origin", await ReadReplicationRoleAsync(db));
    }

    [Fact]
    public async Task CleanupAsync_RejectsProductionBeforeOpeningDatabaseTransaction()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        DemoFixtureSeeder seeder = CreateSeeder(db, Environments.Production);
        SeededDemo demo = await SeedDemoAsync(db);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => seeder.CleanupAsync(demo.Receipt));

        Assert.Contains("Development/test", error.Message, StringComparison.Ordinal);
        Assert.Equal("origin", await ReadReplicationRoleAsync(db));
        Assert.Equal(3, await db.Queryable<Article>().Where(item => demo.ArticleIds.Contains(item.Id)).CountAsync());
        Assert.Equal(2, await db.Queryable<CommentModerationEvent>()
            .Where(item => demo.ModerationEventIds.Contains(item.Id))
            .CountAsync());
    }

    [Fact]
    public async Task AuditFixtureProducer_UsesProtectedProductionStore_AndRerunsExactOwnedSemantics()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        string dataRoot = Path.Combine(Path.GetTempPath(), $"fsusblog-audit-fixture-{Guid.NewGuid():N}");
        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Audit:TamperEvidenceKey"] = "audit-fixture-integration-tamper-key-with-sufficient-entropy",
                    ["FSUSBLOG_DATA_ROOT"] = dataRoot
                })
                .Build();
            var keyStore = new LocalAuditRetentionEpochKeyStore(configuration);
            var protector = new AuditRetentionPayloadProtector(keyStore);
            var store = new AuditLogStore(db, configuration, protector);
            var query = new AuditQueryService(
                db,
                new AuditLogRuntimeState(new AuditLogChannel()),
                configuration,
                protector);
            var producer = new AuditFixtureProducer(store, db, configuration, query);
            await store.WriteBatchAsync(
            [
                new AuditRecord(
                    AuditSourceCatalog.System,
                    AuditTypeCatalog.Infra,
                    new DateTime(2026, 8, 19, 12, 0, 0, DateTimeKind.Utc),
                    "developer-owned audit control",
                    null,
                    Action: AuditActionCatalog.LogRecorded,
                    TargetType: "developer-audit-control")
            ], CancellationToken.None);
            var request = new AuditFixtureRequest(
                "integration-audit",
                "rerun-a",
                new DateTimeOffset(2026, 8, 20, 12, 0, 0, TimeSpan.Zero),
                [
                    AuditFixtureCapabilities.ChainMultiRecord,
                    AuditFixtureCapabilities.HighValue,
                    AuditFixtureCapabilities.InvestigationPage,
                    AuditFixtureCapabilities.LegalHoldEligible,
                    AuditFixtureCapabilities.PseudonymRetention,
                    AuditFixtureCapabilities.SingleValid,
                    AuditFixtureCapabilities.TamperNegative,
                    AuditFixtureCapabilities.UnknownActionNegative
                ]);

            AuditFixtureReceipt first = await producer.PrepareAsync(request);
            AuditFixtureReceipt second = await producer.PrepareAsync(request);

            Assert.Equal("verified", first.Status);
            Assert.Empty(first.Warnings);
            Assert.Equal(7, first.NegativeCases.Count);
            Assert.Equal(6, first.NegativeCases.Count(static item => item.MutationId != "unknown-action"));
            Assert.NotEmpty(first.Retention);
            Assert.All(first.Retention, static item =>
            {
                Assert.True(item.EligibleHoldActiveBeforeExpiry);
                Assert.True(item.EligibleHoldInactiveAtExpiry);
                Assert.Equal("audit_legal_hold_not_allowed", item.IneligibleHoldReason);
            });
            Assert.Equal(3, first.Query?.Total);
            Assert.True(first.Query?.CursorBound, System.Text.Json.JsonSerializer.Serialize(first.Query));
            Assert.True(first.Query?.OrderedDescending);
            Assert.True(first.Query?.PiiRedacted);
            Assert.True(first.Query?.ChainVerified);
            Assert.Equal(nameof(AuditLogStore), first.Authorities.Store);
            Assert.Equal(nameof(AuditRetentionPayloadProtector), first.Authorities.Protector);
            Assert.Equal(nameof(AuditTamperEvidence), first.Authorities.Signer);
            Assert.False(first.Privacy.PlaintextDetected);
            Assert.Equal(first.Records.Count, first.Privacy.ProtectedRecordCount);
            Assert.All(first.Records, static item =>
            {
                Assert.True(item.PayloadProtected);
                Assert.Matches("^[0-9a-f]{64}$", item.RecordHash);
                Assert.Matches("^[0-9a-f]{64}$", item.RecordMacDigest);
            });
            Assert.Equal(first.SemanticRecordSetDigest, second.SemanticRecordSetDigest);
            Assert.NotEqual(
                first.Records.Select(static item => item.RecordHash),
                second.Records.Select(static item => item.RecordHash));
            Assert.Equal(1, await db.Queryable<AuditLog>()
                .Where(item => item.TargetType == "developer-audit-control")
                .CountAsync());
            Assert.DoesNotContain(await db.Queryable<AuditLog>().ToListAsync(), static item =>
                item.EventInfo.Contains("synthetic protected audit fixture", StringComparison.Ordinal));

            await producer.CleanupAsync("integration-audit", "rerun-a");

            Assert.Equal(0, await db.Queryable<AuditLog>()
                .Where(item => item.TargetType!.StartsWith("audit-fixture:"))
                .CountAsync());
            Assert.Equal(1, await db.Queryable<AuditLog>()
                .Where(item => item.TargetType == "developer-audit-control")
                .CountAsync());

            AuditFixtureReceipt scale = await producer.PrepareAsync(new AuditFixtureRequest(
                "integration-audit",
                "scale-1000",
                new DateTimeOffset(2026, 8, 21, 12, 0, 0, TimeSpan.Zero),
                [AuditFixtureCapabilities.ChainMultiRecord],
                ScaleRecordCount: 1000));

            Assert.Equal(1000, scale.Records.Count);
            Assert.Equal(1000, scale.Performance.RecordCount);
            Assert.Equal(10, scale.Performance.BatchCount);
            Assert.Equal(100, scale.Performance.MaximumBatchSize);
            await producer.CleanupAsync("integration-audit", "scale-1000");
        }
        finally
        {
            if (Directory.Exists(dataRoot))
            {
                Directory.Delete(dataRoot, recursive: true);
            }
        }
    }

    private static DemoFixtureSeeder CreateSeeder(
        ISqlSugarClient db,
        string environmentName,
        IAdminArtifactOperations? injectedArtifacts = null,
        bool observeDatabase = false)
    {
        IArticleCoreGateway articles = Substitute.For<IArticleCoreGateway>();
        if (observeDatabase)
        {
            articles.GetHotArticlesAsync(
                    Arg.Any<ArticleCountQuery>(),
                    Arg.Any<CancellationToken>())
                .Returns(_ => ObserveHotArticlesAsync(db));
            articles.GetByIdAsync(
                    Arg.Any<ArticleDetailQuery>(),
                    Arg.Any<CancellationToken>())
                .Returns(call => ObserveArticleDetailAsync(
                    db,
                    call.Arg<ArticleDetailQuery>()));
        }
        else
        {
            articles.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<IReadOnlyList<PopularArticleCoreModel>>([]));
            articles.GetByIdAsync(Arg.Any<ArticleDetailQuery>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<ArticleDetailCoreModel?>(null));
        }

        IAdminArtifactOperations artifacts =
            injectedArtifacts ?? Substitute.For<IAdminArtifactOperations>();
        if (injectedArtifacts is null)
        {
            artifacts.RunCacheActionAsync(Arg.Any<AdminCacheActionRequest>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    string action = call.Arg<AdminCacheActionRequest>().Action;
                    string status = action == "public-hot-rebuild" ? "queued" : "ok";
                    return Task.FromResult(new AdminCacheActionResponse(
                        action,
                        status,
                        "test convergence",
                        DateTimeOffset.UtcNow));
                });
        }

        ISearchIndexService search = Substitute.For<ISearchIndexService>();
        search.SearchAsync(Arg.Any<string>()).Returns(
            observeDatabase
                ? _ => ObserveSearchArticlesAsync(db)
                : _ => Task.FromResult(new List<Article>()));

        ICacheInvalidationDispatcher cacheInvalidation = Substitute.For<ICacheInvalidationDispatcher>();
        IConnectionMultiplexer redisConnection = Substitute.For<IConnectionMultiplexer>();
        IDatabase redis = Substitute.For<IDatabase>();
        redisConnection.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(redis);
        IRuntimeKeyScope runtimeKeyScope = Substitute.For<IRuntimeKeyScope>();
        runtimeKeyScope.PrefixKey(Arg.Any<string>())
            .Returns(static call => call.ArgAt<string>(0));
        IHostEnvironment environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["fsus:localDemoFixtureSecret"] = FixtureSecret,
                ["Audit:TamperEvidenceKey"] = "demo-fixture-audit-tamper-key-with-sufficient-entropy"
            })
            .Build();
        return new DemoFixtureSeeder(
            db,
            articles,
            artifacts,
            search,
            cacheInvalidation,
            redisConnection,
            runtimeKeyScope,
            environment,
            configuration,
            new FixedDemoTimeProvider(),
            new AuditLogStore(db, configuration));
    }

    private static async Task<IReadOnlyList<PopularArticleCoreModel>> ObserveHotArticlesAsync(
        ISqlSugarClient db)
    {
        List<Article> rows = await db.Queryable<Article>().ToListAsync();
        return rows
            .Select(static row => new PopularArticleCoreModel(default, row.Id, row.Title, row.Views))
            .ToArray();
    }

    private static async Task<ArticleDetailCoreModel?> ObserveArticleDetailAsync(
        ISqlSugarClient db,
        ArticleDetailQuery query)
    {
        Article? row = await db.Queryable<Article>().InSingleAsync(query.Id);
        return row is null ? null : default(ArticleDetailCoreModel);
    }

    private static Task<List<Article>> ObserveSearchArticlesAsync(ISqlSugarClient db)
        => db.Queryable<Article>().ToListAsync();

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(AdminPrincipal),
            typeof(Category),
            typeof(Tag),
            typeof(CategoryPublicArticleCount),
            typeof(TagPublicArticleCount),
            typeof(Article),
            typeof(ArticleTag),
            typeof(ArticleBody),
            typeof(ArticleDraft),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticlePublishProof),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationOutboxEdge),
            typeof(ArticleMutationCommand),
            typeof(ArticleAssetReference),
            typeof(ArticlePublicTaxonomyProjection),
            typeof(ArticleViewSeed),
            typeof(ArticleCommentPolicy),
            typeof(CommentSlowModeState),
            typeof(CommentThreadPolicy),
            typeof(CommentPolicyAuditEvent),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentManagementChallenge),
            typeof(CommentAuthorAppeal),
            typeof(CommentReport),
            typeof(CommentModerationEvent),
            typeof(CommentMutationOutboxEvent),
            typeof(CommentMutationOutboxDelivery),
            typeof(CommentModerationQueueClaim),
            typeof(CommentRegionCompliance),
            typeof(CommentBlockedRegion),
            typeof(CommentModerationSignal),
            typeof(AuditLog));

        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE public_article_projection (
                article_id integer PRIMARY KEY
            );
            CREATE OR REPLACE FUNCTION fsus_test_append_comment_moderation_event()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO comment_moderation_event(
                    comment_id, event_type, previous_status, next_status, actor_type,
                    reason_code, transition_source, occurred_at_utc)
                VALUES (
                    NEW.id, 'create', NULL, NEW.moderation_status, 'system',
                    NEW.moderation_reason, 'initial',
                    COALESCE(NEW.moderated_at, NEW.create_time, now() AT TIME ZONE 'utc'));
                RETURN NEW;
            END; $$;
            CREATE TRIGGER trg_comment_moderation_event
            AFTER INSERT ON comment
            FOR EACH ROW EXECUTE FUNCTION fsus_test_append_comment_moderation_event();

            CREATE OR REPLACE FUNCTION fsus_test_reject_comment_moderation_event_mutation()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'comment_moderation_event is append-only';
            END; $$;
            CREATE TRIGGER trg_comment_moderation_event_append_only
            BEFORE UPDATE OR DELETE ON comment_moderation_event
            FOR EACH ROW EXECUTE FUNCTION fsus_test_reject_comment_moderation_event_mutation();
            """);
        return db;
    }

    private sealed class FixedDemoTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
            => new(2024, 2, 29, 23, 59, 59, TimeSpan.Zero);
    }

    private static async Task<SeededDemo> SeedDemoAsync(ISqlSugarClient db)
    {
        const string UserHandle = "demo-reader-0123456789abcdef01234567";
        const string AdminHandle = "demo-admin-0123456789abcdef01234567";
        string Name(string role) => Owner + ":" + role;

        int userId = await db.Insertable(new User
        {
            PublicHandle = UserHandle,
            IdentityKind = "anonymous_account"
        }).ExecuteReturnIdentityAsync();
        long adminId = await db.Insertable(new AdminPrincipal
        {
            Handle = AdminHandle,
            Status = AdminPrincipalStatus.Disabled,
            Permissions = string.Empty
        }).ExecuteReturnBigIdentityAsync();
        int[] categories =
        [
            await db.Insertable(new Category { Name = Name("category-public-preview") }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Category { Name = Name("category-operations") }).ExecuteReturnIdentityAsync()
        ];
        int[] tags =
        [
            await db.Insertable(new Tag { Name = Name("tag-demo") }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Tag { Name = Name("tag-aeds") }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Tag { Name = Name("tag-public-aot") }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Tag { Name = Name("tag-moderation") }).ExecuteReturnIdentityAsync()
        ];
        string[] roles = ["public-preview", "aeds-notes", "moderation-queue"];
        string[] titles =
        [
            Name("article-public-preview") + " Public Preview Walkthrough",
            Name("article-aeds-notes") + " AEDS And Public AOT Notes",
            Name("article-moderation-queue") + " Moderation Queue Overview"
        ];
        int[] articles =
        [
            await db.Insertable(new Article { Title = titles[0], CategoryId = categories[0] }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Article { Title = titles[1], CategoryId = categories[1] }).ExecuteReturnIdentityAsync(),
            await db.Insertable(new Article { Title = titles[2], CategoryId = categories[1] }).ExecuteReturnIdentityAsync()
        ];
        long[] revisions = new long[3];
        long[] publications = new long[3];
        for (int index = 0; index < articles.Length; index++)
        {
            long contentBlockId = await db.Insertable(new ArticleRevisionContentBlock
            {
                ContentHash = new string((char)('a' + index), 64),
                MarkdownContent = $"# {roles[index]}",
                ByteLength = roles[index].Length,
                CreatedAt = DateTime.UtcNow
            }).ExecuteReturnBigIdentityAsync();
            revisions[index] = await db.Insertable(new ArticleRevision
            {
                ArticleId = articles[index],
                RevisionNo = 1,
                ContentBlockId = contentBlockId,
                CreatedByAdminPrincipalId = adminId
            }).ExecuteReturnBigIdentityAsync();
            publications[index] = await db.Insertable(new ArticlePublicationRecord
            {
                ArticleId = articles[index],
                PublicationNo = 1,
                ArticleRevisionId = revisions[index]
            }).ExecuteReturnBigIdentityAsync();
            long currentRevisionId = revisions[index];
            long currentPublicationId = publications[index];
            await db.Updateable<Article>()
                .SetColumns(item => item.CurrentRevisionId == currentRevisionId)
                .SetColumns(item => item.CurrentPublicationId == currentPublicationId)
                .Where(item => item.Id == articles[index])
                .ExecuteCommandAsync();
        }

        long[] comments = [98101, 98102];
        await db.Insertable(new Comment
        {
            Id = comments[0],
            ArticleId = articles[0],
            Content = "[demo fixture] approved",
            CreateTime = DateTime.UtcNow,
            CurrentVersion = 1,
            AuthorMode = "zk_anonymous",
            AnonymousHandle = UserHandle,
            AnonymousScope = Name("comment-approved"),
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommandAsync();
        await db.Insertable(new Comment
        {
            Id = comments[1],
            ArticleId = articles[1],
            Content = "[demo fixture] pending",
            CreateTime = DateTime.UtcNow,
            CurrentVersion = 1,
            AuthorMode = "zk_anonymous",
            AnonymousHandle = UserHandle,
            AnonymousScope = Name("comment-pending"),
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Pending
        }).ExecuteCommandAsync();
        await db.Insertable(comments.Select((commentId, index) => new CommentRevision
        {
            CommentId = commentId,
            Version = 1,
            Content = index == 0 ? "[demo fixture] approved" : "[demo fixture] pending",
            ContentSha256 = new string((char)('d' + index), 64),
            Operation = CommentRevisionOperations.Created,
            CreatedAtUtc = DateTime.UtcNow,
            ActorMode = "zk_anonymous"
        }).ToArray()).ExecuteCommandAsync();

        List<CommentModerationEvent> moderationEvents = await db.Queryable<CommentModerationEvent>()
            .Where(item => comments.Contains(item.CommentId))
            .OrderBy(item => item.CommentId)
            .ToListAsync();
        IConfiguration auditConfiguration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = "demo-fixture-audit-tamper-key-with-sufficient-entropy"
            })
            .Build();
        var auditStore = new AuditLogStore(db, auditConfiguration);
        await auditStore.WriteBatchAsync(
        [
            new AuditRecord(
                AuditSourceCatalog.System,
                AuditTypeCatalog.Infra,
                new DateTime(2026, 6, 1, 12, 0, 0, DateTimeKind.Utc),
                "Fictional public AOT demo observation",
                null,
                Action: AuditActionCatalog.PublicAotCache,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.System,
                TargetType: "demo-fixture",
                TargetId: Name("audit-security")),
            new AuditRecord(
                AuditSourceCatalog.Comment,
                AuditTypeCatalog.Business,
                new DateTime(2026, 6, 2, 12, 0, 0, DateTimeKind.Utc),
                "Fictional moderation queue demo event",
                null,
                Action: AuditActionCatalog.CommentModerated,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.System,
                TargetType: "demo-fixture",
                TargetId: Name("audit-moderation"))
        ],
        CancellationToken.None);
        string securityTarget = Name("audit-security");
        string moderationTarget = Name("audit-moderation");
        long[] audits = (await db.Queryable<AuditLog>()
            .Where(item => item.TargetType == "demo-fixture"
                && (item.TargetId == securityTarget
                    || item.TargetId == moderationTarget))
            .OrderBy(item => item.OccurredAtUtc)
            .Select(item => item.Id)
            .ToListAsync()).ToArray();
        Assert.Equal(2, audits.Length);

        var receipt = new List<DemoEntityIdentity>();
        void Add(string kind, long id, string? handle = null)
        {
            var identity = new DemoEntityIdentity(
                kind,
                id.ToString(),
                handle,
                VariantId,
                Owner);
            receipt.Add(identity with
            {
                Digest = DemoFixtureSeeder.ComputeIdentityDigest(FixtureSecret, identity)
            });
        }

        Add("user", userId, UserHandle);
        Add("admin-principal", adminId, AdminHandle);
        Add("category", categories[0], Name("category-public-preview"));
        Add("category", categories[1], Name("category-operations"));
        Add("tag", tags[0], Name("tag-demo"));
        Add("tag", tags[1], Name("tag-aeds"));
        Add("tag", tags[2], Name("tag-public-aot"));
        Add("tag", tags[3], Name("tag-moderation"));
        for (int index = 0; index < roles.Length; index++)
        {
            Add("article", articles[index], roles[index]);
            Add("article-revision", revisions[index], roles[index]);
            Add("article-publication", publications[index], roles[index]);
        }
        Add("comment", comments[0], "approved");
        Add("comment", comments[1], "pending");
        Add("comment-moderation-event", moderationEvents.Single(item => item.CommentId == comments[0]).Id, "approved");
        Add("comment-moderation-event", moderationEvents.Single(item => item.CommentId == comments[1]).Id, "pending");
        Add("audit-event", audits[0], "security");
        Add("audit-event", audits[1], "moderation");

        return new SeededDemo(
            articles,
            comments,
            moderationEvents.Select(static item => item.Id).ToArray(),
            receipt);
    }

    private static ReceiptIds ParseReceiptIds(IReadOnlyList<DemoEntityIdentity> receipt)
    {
        int[] IntIds(string kind) => receipt
            .Where(item => item.Kind == kind)
            .Select(item => int.Parse(item.Id, System.Globalization.CultureInfo.InvariantCulture))
            .ToArray();
        long[] LongIds(string kind) => receipt
            .Where(item => item.Kind == kind)
            .Select(item => long.Parse(item.Id, System.Globalization.CultureInfo.InvariantCulture))
            .ToArray();

        return new ReceiptIds(
            IntIds("user").Single(),
            LongIds("admin-principal").Single(),
            IntIds("category"),
            IntIds("tag"),
            IntIds("article"),
            LongIds("article-revision"),
            LongIds("article-publication"),
            LongIds("comment"),
            LongIds("comment-moderation-event"),
            LongIds("audit-event"));
    }

    private static async Task AssertReceiptRowsAbsentAsync(
        ISqlSugarClient db,
        ReceiptIds ids)
    {
        Assert.Equal(0, await db.Queryable<User>().Where(item => item.Id == ids.UserId).CountAsync());
        Assert.Equal(0, await db.Queryable<AdminPrincipal>().Where(item => item.Id == ids.AdminPrincipalId).CountAsync());
        Assert.Equal(0, await db.Queryable<Category>().Where(item => ids.CategoryIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<Tag>().Where(item => ids.TagIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<Article>().Where(item => ids.ArticleIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRevision>().Where(item => ids.RevisionIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<ArticlePublicationRecord>().Where(item => ids.PublicationIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<Comment>().Where(item => ids.CommentIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<CommentModerationEvent>().Where(item => ids.ModerationEventIds.Contains(item.Id)).CountAsync());
        Assert.Equal(0, await db.Queryable<AuditLog>().Where(item => ids.AuditIds.Contains(item.Id)).CountAsync());
    }

    private static async Task<string> ReadReplicationRoleAsync(ISqlSugarClient db)
    {
        using System.Data.Common.DbDataReader reader =
            (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync("SHOW session_replication_role;");
        Assert.True(await reader.ReadAsync());
        return reader.GetString(0);
    }

    private sealed record SeededDemo(
        int[] ArticleIds,
        long[] CommentIds,
        long[] ModerationEventIds,
        IReadOnlyList<DemoEntityIdentity> Receipt);

    private sealed record ReceiptIds(
        int UserId,
        long AdminPrincipalId,
        int[] CategoryIds,
        int[] TagIds,
        int[] ArticleIds,
        long[] RevisionIds,
        long[] PublicationIds,
        long[] CommentIds,
        long[] ModerationEventIds,
        long[] AuditIds);
}
