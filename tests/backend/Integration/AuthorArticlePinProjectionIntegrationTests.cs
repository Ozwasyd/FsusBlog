using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorArticlePinProjectionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Fact]
    public async Task Projection_ConsumesRealPinArticleAndRevisionFactsAndInvalidatesOnCurrentRevisionChange()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var pins = new AuthorArticlePinStore(db, TimeProvider.System);
        long revision = 0;
        for (int articleId = 1; articleId <= 4; articleId++)
        {
            revision = (await pins.AddAsync(new AddAuthorArticlePinCommand(
                s_owner,
                articleId,
                revision,
                Guid.CreateVersion7()))).Revision;
        }
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article SET status = 4, isdeleted = TRUE WHERE id = 3;
            DELETE FROM article WHERE id = 4;
            """);

        var permissions = new LocalSimulationPermissionProvider();
        var articleFacts = new RecordingArticleSource(new SqlAuthorArticlePinArticleProjectionSource(db));
        var reconciliation = new RecordingReconciliationSink();
        var service = new AuthorArticlePinProjectionService(
            pins,
            permissions,
            articleFacts,
            new DirectAuthorArticlePinProjectionCache(),
            reconciliation,
            TimeProvider.System);
        AuthorArticlePinProjectionRequest request = new(s_owner, Guid.CreateVersion7());

        AuthorArticlePinProjectionPage initial = await service.ReadAsync(request);

        Assert.Equal(AuthorArticlePinProjectionStatus.Current, initial.Status);
        Assert.Equal(new[] { 1, 2 }, initial.Items.Select(static item => item.ArticleId));
        Assert.Equal(ArticleStatus.Archived, initial.Items[1].Status);
        Assert.Equal(new[] { 3, 4 }, reconciliation.Obligations.Select(static item => item.ArticleId));
        Assert.Equal(new[] { "article-deleted", "article-missing" }, reconciliation.Obligations.Select(static item => item.ReasonCode));
        Assert.Equal(new[] { 1, 2, 3, 4 }, Assert.Single(articleFacts.Requests));
        AuthorArticlePinCollectionSnapshot collection = await pins.GetAuthoritySnapshotAsync(s_owner);
        AuthorArticlePinProjectionVerificationResult verified = AuthorArticlePinProjectionVerifier.Verify(
            new AuthorArticlePinProjectionVerificationInput(
                collection,
                permissions.LastSnapshot!,
                articleFacts.LastFacts,
                request,
                initial,
                ClosedRemovals: reconciliation.Obligations));
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET views = views + 100 WHERE id = 1;");
        AuthorArticlePinProjectionPage viewsChanged = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Current, viewsChanged.Status);
        Assert.Equal(initial.ArticleProjectionDigest, viewsChanged.ArticleProjectionDigest);
        Assert.Equal(initial.CacheReference, viewsChanged.CacheReference);
        Assert.Equal(initial.Items, viewsChanged.Items);

        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_revision(id, article_id, revision_no) VALUES (11, 1, 2);
            UPDATE article SET title = 'renamed without identity change', current_revision_id = 11 WHERE id = 1;
            """);
        AuthorArticlePinProjectionPage changed = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7(),
            ExpectedCollectionRevision = initial.CollectionRevision,
            ExpectedArticleProjectionDigest = initial.ArticleProjectionDigest,
            ExpectedPermissionRevision = initial.PermissionRevision,
            ExpectedSiteRevision = initial.SiteRevision,
            ExpectedSessionRevision = initial.SessionRevision
        });

        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, changed.Status);
        Assert.Contains("article_projection_stale", changed.StaleReasons);
        Assert.Equal(1, changed.Items[0].ArticleId);
        Assert.Equal("renamed without identity change", changed.Items[0].Title);
        Assert.Equal(11, changed.Items[0].CurrentRevisionId);
        Assert.NotEqual(initial.CacheReference, changed.CacheReference);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET current_revision_id = 20 WHERE id = 1;");
        AuthorArticlePinProjectionPage crossArticleRevision = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, crossArticleRevision.Status);
        Assert.Contains("article_pin_article_projection_invalid", crossArticleRevision.StaleReasons);
    }

    [Fact]
    public async Task ArticleSource_ResolvesOneThousandStableIdentitiesInOnePostgresBatch()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_revision(id, article_id, revision_no)
            SELECT 10000 + article_id, article_id, 1
            FROM generate_series(5, 1000) AS generated(article_id);
            INSERT INTO article(id, title, status, isdeleted, current_revision_id)
            SELECT article_id,
                   concat('title-', article_id::text),
                   2,
                   FALSE,
                   10000 + article_id
            FROM generate_series(5, 1000) AS generated(article_id);
            """);
        int[] articleIds = Enumerable.Range(1, AuthorArticlePinContract.MaxPinsPerOwner).ToArray();
        var source = new RecordingArticleSource(new SqlAuthorArticlePinArticleProjectionSource(db));

        IReadOnlyList<AuthorArticlePinArticleFact> facts = await source.ReadCurrentBatchAsync(articleIds);

        Assert.Equal(AuthorArticlePinContract.MaxPinsPerOwner, facts.Count);
        Assert.Equal(articleIds, facts.Select(static fact => fact.ArticleId));
        Assert.Equal(articleIds, Assert.Single(source.Requests));
        Assert.All(facts, static fact =>
        {
            Assert.True(fact.Exists);
            Assert.False(fact.IsDeleted);
            Assert.True(fact.CurrentRevisionId > 0);
            Assert.Equal(1, fact.RevisionNo);
            Assert.Equal(
                AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact),
                fact.ContentDigest);
        });
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY);
            INSERT INTO admin_principal(id) VALUES (1);
            CREATE TABLE article_revision(
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                revision_no integer NOT NULL);
            INSERT INTO article_revision(id, article_id, revision_no)
            VALUES (10, 1, 1), (20, 2, 1), (30, 3, 1), (40, 4, 1);
            CREATE TABLE article(
                id integer PRIMARY KEY,
                title varchar(256) NOT NULL,
                status integer NOT NULL,
                isdeleted boolean NOT NULL,
                views integer NOT NULL DEFAULT 0,
                current_revision_id bigint NULL REFERENCES article_revision(id));
            INSERT INTO article(id, title, status, isdeleted, current_revision_id)
            VALUES
                (1, 'active title', 2, FALSE, 10),
                (2, 'archived title', 3, FALSE, 20),
                (3, 'deleted title', 2, FALSE, 30),
                (4, 'missing title', 0, FALSE, 40);
            """);
        ISchemaMigrationDescriptor migration = AuthorArticlePinMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    /// <summary>
    /// Deterministic local simulation of the external #2231 authority. It is test evidence only and
    /// must not be registered as a production permission provider.
    /// </summary>
    private sealed class LocalSimulationPermissionProvider : IAuthorArticlePinPermissionProjectionProvider
    {
        public AuthorArticlePinPermissionSnapshot? LastSnapshot
        {
            get; private set;
        }

        public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var snapshot = new AuthorArticlePinPermissionSnapshot(
                AuthorArticlePinPermissionSnapshotStatus.Current,
                request.Owner,
                "permission:pg:1",
                "site:pg:1",
                "session:pg:1",
                [.. request.ArticleIds.Select(articleId => new AuthorArticlePinPermissionDecision(
                    articleId,
                    CanProject: true,
                    CanOpen: true,
                    $"permission:pg:article:{articleId}"))],
                string.Empty);
            LastSnapshot = snapshot with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
            };
            return Task.FromResult(LastSnapshot);
        }
    }

    private sealed class RecordingArticleSource(IAuthorArticlePinArticleProjectionSource inner)
        : IAuthorArticlePinArticleProjectionSource
    {
        public List<int[]> Requests { get; } = [];
        public IReadOnlyList<AuthorArticlePinArticleFact> LastFacts { get; private set; } = [];

        public async Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            Requests.Add([.. articleIds]);
            LastFacts = await inner.ReadCurrentBatchAsync(articleIds, cancellationToken).ConfigureAwait(false);
            return LastFacts;
        }
    }

    private sealed class RecordingReconciliationSink : IAuthorArticlePinReconciliationSink
    {
        public List<AuthorArticlePinClosedRemovalObligation> Obligations { get; } = [];

        public Task<bool> RecordClosedRemovalsAsync(
            IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Obligations.Clear();
            Obligations.AddRange(obligations);
            return Task.FromResult(true);
        }
    }
}
