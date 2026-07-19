using FsusBlog.Core.Integrity;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleRightsWritePathTests(
    PostgresSchemaMigrationFixture fixture,
    ArticleRightsWritePathDatabaseFixture classDatabase)
    : IClassFixture<ArticleRightsWritePathDatabaseFixture>, IAsyncLifetime
{
    [Fact]
    public async Task CreateAsync_WritesRightsPolicySnapshotAndOutboxInSameTransaction()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        ArticleService service = CreateService(db);

        int articleId = await service.CreateAsync(new CreateArticleRequest
        {
            Title = "Rights article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [2, 1],
            Status = ArticleStatus.Published,
            Rights = CustomRights("CC-BY-4.0", "Fésus", showBadge: false)
        });

        ArticleRevision revision = Assert.Single(await db.Queryable<ArticleRevision>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync());
        ArticleRightsPolicy policy = Assert.Single(await db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync());
        ArticleRightsSnapshot snapshot = Assert.Single(await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync());
        ArticleMutationOutboxEvent outbox = Assert.Single(await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.AggregateId == articleId)
            .ToListAsync());

        Assert.True(articleId > 0);
        Assert.Equal(revision.Id, snapshot.ArticleRevisionId);
        Assert.Equal(revision.RevisionNo, snapshot.RevisionNo);
        Assert.Equal(policy.Id, snapshot.ArticleRightsPolicyId);
        Assert.Equal("CC-BY-4.0", policy.LicenseType);
        Assert.Equal("Fésus", snapshot.CopyrightHolder);
        Assert.False(snapshot.ShowPublicBadge);
        Assert.StartsWith("sha256:", snapshot.PolicyHash, StringComparison.Ordinal);
        Assert.StartsWith("sha256:", snapshot.ContentCanonicalHash, StringComparison.Ordinal);
        Assert.Equal(BuildExpectedPolicyHash(articleId, revision, snapshot), snapshot.PolicyHash);
        Assert.Contains($"\"rightsSnapshotId\":{snapshot.Id}", outbox.PayloadJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateAsync_PublishedArticleEstablishesGlobalFenceBeforeInsert()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Assert.Equal(0, db.Queryable<Article>().Count());
                return Task.CompletedTask;
            });
        ArticleService service = CreateService(db, mutationFence);

        int articleId = await service.CreateAsync(new CreateArticleRequest
        {
            Title = "Fenced article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [],
            Status = ArticleStatus.Published
        });

        Assert.True(articleId > 0);
        await mutationFence.Received(1)
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                null,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CreateAsync_WhenGlobalFenceFails_WritesNoArticleOrOutbox()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(null, Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("global tombstone unavailable")));
        ArticleService service = CreateService(db, mutationFence);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.CreateAsync(new CreateArticleRequest
            {
                Title = "must not exist",
                Content = "# body",
                Summary = "summary",
                CategoryId = 1,
                TagIds = [],
                Status = ArticleStatus.Published
            }));

        Assert.Equal("global tombstone unavailable", error.Message);
        Assert.Equal(0, db.Queryable<Article>().Count());
        Assert.Equal(0, db.Queryable<ArticleMutationOutboxEvent>().Count());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                null,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CreateAsync_WhenPublicationTaxonomyIsInvalid_WritesNothing()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));
        ArticleService service = CreateService(
            db,
            publicationValidator: new ArticlePublicationValidator(db, contentFilter));

        ArticleWriteValidationException error = await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            service.CreateAsync(new CreateArticleRequest
            {
                Title = "Invalid taxonomy",
                Content = "# body",
                Summary = "summary",
                CategoryId = 404,
                TagIds = [999],
                Status = ArticleStatus.Published
            }));

        Assert.Equal("category_not_found", error.Code);
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRevision>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
    }

    [Fact]
    public async Task CreateAsync_UsesDefaultRightsWhenRequestOmitsRights()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        Exception? sqlError = null;
        db.Aop.OnError = exception => sqlError = exception;
        CreateTables(db);
        ArticleService service = CreateService(db);

        int articleId = await service.CreateAsync(new CreateArticleRequest
        {
            Title = "Default rights article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [1],
            Status = ArticleStatus.Published
        });

        Assert.True(articleId > 0, sqlError?.ToString() ?? "Article create returned 0 without a captured SQL error.");
        ArticleRightsPolicy policy = Assert.Single(await db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync());
        ArticleRightsSnapshot snapshot = Assert.Single(await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync());
        ArticleMutationOutboxEvent outbox = Assert.Single(await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.AggregateId == articleId)
            .ToListAsync());

        Assert.Equal("all-rights-reserved", policy.LicenseType);
        Assert.Equal("append-attribution", policy.CopyPolicy);
        Assert.Equal(300, policy.MaxExcerptChars);
        Assert.True(policy.Enabled);
        Assert.True(policy.AllowCodeCopy);
        Assert.True(policy.ShowPublicBadge);
        Assert.True(policy.ProofBindingEnabled);
        Assert.Null(policy.CopyrightHolder);
        Assert.Null(policy.CopyrightYear);
        Assert.Null(policy.RightsStatement);
        Assert.Null(policy.AttributionTemplate);
        Assert.Equal(policy.LicenseType, snapshot.LicenseType);
        Assert.Equal(policy.CopyPolicy, snapshot.CopyPolicy);
        Assert.Null(snapshot.CopyrightHolder);
        Assert.Null(snapshot.CopyrightYear);
        Assert.Null(snapshot.RightsStatement);
        Assert.Null(snapshot.AttributionTemplate);
        Assert.Contains($"\"rightsSnapshotId\":{snapshot.Id}", outbox.PayloadJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UpdateAsync_RightsOnlyChangeCreatesNewRevisionSnapshotAndOutboxPointer()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        ArticleService service = CreateService(db);
        int articleId = await service.CreateAsync(new CreateArticleRequest
        {
            Title = "Rights article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [1],
            Status = ArticleStatus.Published,
            Rights = CustomRights("all-rights-reserved", "Original", showBadge: true)
        });

        bool updated = await service.UpdateAsync(articleId, new UpdateArticleRequest
        {
            Title = "Rights article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [1],
            Status = ArticleStatus.Published,
            Rights = CustomRights("CC-BY-4.0", "Updated", showBadge: false)
        });

        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(item => item.ArticleId == articleId)
            .OrderBy(item => item.RevisionNo)
            .ToListAsync();
        List<ArticleRightsSnapshot> snapshots = await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.ArticleId == articleId)
            .OrderBy(item => item.RevisionNo)
            .ToListAsync();
        ArticleMutationOutboxEvent latestOutbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.AggregateId == articleId)
            .OrderByDescending(item => item.Id)
            .FirstAsync();

        Assert.True(updated);
        Assert.Equal([1, 2], revisions.Select(static item => item.RevisionNo).ToArray());
        Assert.Equal([1, 2], snapshots.Select(static item => item.RevisionNo).ToArray());
        Assert.Equal(revisions[1].Id, snapshots[1].ArticleRevisionId);
        Assert.Equal("Updated", snapshots[1].CopyrightHolder);
        Assert.Equal("CC-BY-4.0", snapshots[1].LicenseType);
        Assert.Contains($"\"rightsSnapshotId\":{snapshots[1].Id}", latestOutbox.PayloadJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateAsync_RollsBackArticlePolicyAndOutboxWhenSnapshotInsertFails()
    {
        using SqlSugarClient db = classDatabase.CreateClient();
        CreateTables(db);
        InstallFailingRightsSnapshotTrigger(db);
        ArticleService service = CreateService(db);

        int articleId = await service.CreateAsync(new CreateArticleRequest
        {
            Title = "Rights article",
            Content = "# body",
            Summary = "summary",
            CategoryId = 1,
            TagIds = [1],
            Status = ArticleStatus.Published,
            Rights = CustomRights("CC-BY-4.0", "Fésus", showBadge: true)
        });

        Assert.Equal(0, articleId);
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRightsPolicy>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleRightsSnapshot>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
    }

    private static ArticleRightsRequest CustomRights(string licenseType, string holder, bool showBadge)
        => new()
        {
            Enabled = true,
            LicenseType = licenseType,
            CopyrightHolder = holder,
            CopyrightYear = 2026,
            RightsStatement = "Line one\nLine two",
            AttributionTemplate = "{title} — {holder}",
            CopyPolicy = "append-attribution",
            MaxExcerptChars = 300,
            AllowCodeCopy = true,
            ShowPublicBadge = showBadge,
            ProofBindingEnabled = true
        };

    public async Task InitializeAsync()
        => _ = await classDatabase.ResetAsync(fixture);

    public Task DisposeAsync() => Task.CompletedTask;

    private static string BuildExpectedPolicyHash(int articleId, ArticleRevision revision, ArticleRightsSnapshot snapshot)
        => ArticleRightsCanonicalHashV1.ComputeHashHex(new ArticleRightsCanonicalInput(
            ArticleId: articleId,
            ArticleRevisionId: revision.Id,
            RevisionNo: revision.RevisionNo,
            LicenseType: snapshot.LicenseType,
            CopyrightHolder: snapshot.CopyrightHolder,
            CopyrightYear: snapshot.CopyrightYear,
            RightsStatement: snapshot.RightsStatement,
            AttributionTemplate: snapshot.AttributionTemplate,
            CopyPolicy: snapshot.CopyPolicy,
            MaxExcerptChars: snapshot.MaxExcerptChars,
            AllowCodeCopy: snapshot.AllowCodeCopy,
            ShowPublicBadge: snapshot.ShowPublicBadge,
            CanonicalUrl: snapshot.CanonicalUrl,
            ContentCanonicalHash: snapshot.ContentCanonicalHash));

    private static void InstallFailingRightsSnapshotTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_article_rights_snapshot_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                RAISE EXCEPTION 'unit rights snapshot insert failure';
            END;
            $$;

            CREATE TRIGGER fail_article_rights_snapshot_insert
            BEFORE INSERT ON article_rights_snapshot
            FOR EACH ROW
            EXECUTE FUNCTION fail_article_rights_snapshot_insert();
            """);

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag),
            typeof(ArticleRevision),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof));

    private static ArticleService CreateService(
        SqlSugarClient db,
        IArticlePublicMutationFence? mutationFence = null,
        IArticlePublicationValidator? publicationValidator = null)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: mutationFence ?? Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: publicationValidator ?? ArticlePublicationValidatorTestFactory.CreateAllowing());
    }
}
