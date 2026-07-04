using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class ArticleRightsWritePathTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CreateAsync_WritesRightsPolicySnapshotAndOutboxInSameTransaction()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
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
    public async Task CreateAsync_UsesDefaultRightsWhenRequestOmitsRights()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
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
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
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
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
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

    private static ArticleService CreateService(SqlSugarClient db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cache: Substitute.For<IUnifiedCache>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>());
    }
}
