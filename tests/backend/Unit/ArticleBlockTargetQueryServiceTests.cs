using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleBlockTargetQueryServiceTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly ArticleRelationActorContext s_actor = new("actor:query", "site:primary", Digest);
    private static readonly BlockTargetQueryCoordinate s_coordinate = new(s_actor.ActorIdentity, s_actor.SiteIdentity,
        s_actor.PermissionContextDigest, 7, 11, 13, 17, BlockAnchorSchemas.Version, BlockAnchorContractDigest.ComputeContract());

    [Fact]
    public async Task ArticleAndHeadingMethods_ReturnExistingPagesFromActualIndex()
    {
        var fixture = await Fixture.CreateAsync(3, 3);
        BlockTargetQueryRequest articles = Request(limit: 2);
        BlockTargetArticleQueryPage first = await fixture.Service.QueryArticlesAsync(articles);
        Assert.True(BlockTargetQueryValidator.Validate(first, articles).IsValid);
        Assert.Equal(BlockTargetQueryPageStatus.Ready, first.Status);
        Assert.Equal(2, first.Items.Count);
        Assert.NotNull(first.Next);
        BlockTargetArticleQueryPage last = await fixture.Service.QueryArticlesAsync(articles, first.Next);
        Assert.Single(last.Items);
        Assert.Null(last.Next);
        BlockTargetQueryRequest headings = Request(BlockTargetQueryLayer.Headings, fixture.Source.Articles[0].Article, 2);
        BlockTargetHeadingQueryPage headingPage = await fixture.Service.QueryHeadingsAsync(headings);
        Assert.True(BlockTargetQueryValidator.Validate(headingPage, headings).IsValid);
        Assert.Equal(2, headingPage.Items.Count);
        Assert.NotNull(headingPage.Next);
        BlockTargetHeadingQueryPage headingLast = await fixture.Service.QueryHeadingsAsync(headings, headingPage.Next);
        Assert.Single(headingLast.Items);
        Assert.NotEmpty(fixture.Relations.PageReads);
        Assert.Equal(1, fixture.Source.Observation.IndexGeneration);
        Assert.Equal(13, fixture.Source.Observation.Coordinate.IndexRevision);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("query")]
    [InlineData("index")]
    [InlineData("route")]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("permission-context")]
    [InlineData("scope")]
    [InlineData("source-generation")]
    [InlineData("index-generation")]
    public async Task IndependentObservations_RefuseEveryBindingDriftBeforeMetadataRead(string fault)
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.Observation = Changed(fixture.Source.Observation, fault);
        BlockTargetQueryRequest request = Request();
        BlockTargetArticleQueryPage page = await fixture.Service.QueryArticlesAsync(request);
        AssertUnavailable(page);
        Assert.Empty(fixture.Source.ArticlePageReads);
        Assert.True(BlockTargetQueryValidator.Validate(page, request).IsValid);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("query")]
    [InlineData("index")]
    [InlineData("route")]
    [InlineData("source-generation")]
    [InlineData("index-generation")]
    public async Task ObservationDriftAfterRead_DiscardsAlreadyPreparedItems(string fault)
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.AfterRead = () => fixture.Source.Observation = Changed(fixture.Source.Observation, fault);
        AssertUnavailable(await fixture.Service.QueryArticlesAsync(Request()));
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("reordered")]
    [InlineData("oversized")]
    [InlineData("private-lookahead")]
    [InlineData("stale-content")]
    [InlineData("stale-revision")]
    [InlineData("unindexed")]
    [InlineData("default")]
    [InlineData("foreign-observation")]
    public async Task ArticleSourceFault_RefusesWholePageIncludingLookahead(string fault)
    {
        var fixture = await Fixture.CreateAsync(3);
        fixture.Source.ArticleFault = fault;
        AssertUnavailable(await fixture.Service.QueryArticlesAsync(Request(limit: 2)));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("denied")]
    [InlineData("readonly")]
    [InlineData("archived")]
    [InlineData("deleted")]
    [InlineData("changed-route")]
    [InlineData("changed-revision")]
    public async Task HeadingQuery_AuthorizesExactArticleBeforeReadingAnyInventory(string fault)
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.SelectedFault = fault;
        BlockTargetHeadingQueryPage page = await fixture.Service.QueryHeadingsAsync(
            Request(BlockTargetQueryLayer.Headings, fixture.Source.Articles[0].Article));
        Assert.Equal(BlockTargetQueryPageStatus.Unavailable, page.Status);
        Assert.Empty(page.Items);
        Assert.Equal(BlockTargetInventoryDiagnostic.None, page.Diagnostic);
        Assert.Null(page.Next);
        Assert.Equal(0, fixture.Source.HeadingReads);
    }

    [Theory]
    [InlineData(BlockTargetInventoryDiagnostic.Duplicate)]
    [InlineData(BlockTargetInventoryDiagnostic.Invalid)]
    [InlineData(BlockTargetInventoryDiagnostic.Malformed)]
    [InlineData(BlockTargetInventoryDiagnostic.Orphan)]
    public async Task AuthorizedCanonicalDiagnostics_BlockAllHeadingResults(BlockTargetInventoryDiagnostic diagnostic)
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.Diagnostic = diagnostic;
        BlockTargetQueryRequest request = Request(BlockTargetQueryLayer.Headings, fixture.Source.Articles[0].Article);
        BlockTargetHeadingQueryPage page = await fixture.Service.QueryHeadingsAsync(request);
        Assert.Equal(BlockTargetQueryPageStatus.Blocked, page.Status);
        Assert.Equal(diagnostic, page.Diagnostic);
        Assert.Empty(page.Items);
        Assert.Null(page.Next);
        Assert.True(BlockTargetQueryValidator.Validate(page, request).IsValid);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("reordered")]
    [InlineData("oversized")]
    [InlineData("article")]
    [InlineData("range")]
    [InlineData("unknown-diagnostic")]
    [InlineData("blocked-content")]
    [InlineData("outside-source")]
    public async Task HeadingSourceFault_ProducesNoSelectableOrDiagnosticLeak(string fault)
    {
        var fixture = await Fixture.CreateAsync(1, 3);
        fixture.Source.HeadingFault = fault;
        BlockTargetHeadingQueryPage page = await fixture.Service.QueryHeadingsAsync(
            Request(BlockTargetQueryLayer.Headings, fixture.Source.Articles[0].Article, 2));
        Assert.Equal(BlockTargetQueryPageStatus.Unavailable, page.Status);
        Assert.Equal(BlockTargetInventoryDiagnostic.None, page.Diagnostic);
        Assert.Empty(page.Items);
        Assert.Null(page.Next);
    }

    [Theory]
    [InlineData(ArticleRelationLifecycleState.Published, BlockTargetQueryPageStatus.Ready)]
    [InlineData(ArticleRelationLifecycleState.Draft, BlockTargetQueryPageStatus.Unavailable)]
    [InlineData(ArticleRelationLifecycleState.Scheduled, BlockTargetQueryPageStatus.Unavailable)]
    [InlineData(ArticleRelationLifecycleState.Archived, BlockTargetQueryPageStatus.Unavailable)]
    [InlineData(ArticleRelationLifecycleState.Deleted, BlockTargetQueryPageStatus.Unavailable)]
    public async Task PublicScope_RequiresCurrentPublicationAndDoesNotRequireTargetEditRights(
        ArticleRelationLifecycleState lifecycle, BlockTargetQueryPageStatus expected)
    {
        var fixture = await Fixture.CreateAsync(publication: true, lifecycle: lifecycle);
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Scope = BlockTargetQueryScope.CurrentPublicPublication
        });
        BlockTargetArticleQueryPage page = await fixture.Service.QueryArticlesAsync(request);
        Assert.Equal(expected, page.Status);
        Assert.True(BlockTargetQueryValidator.Validate(page, request).IsValid);
        if (expected == BlockTargetQueryPageStatus.Ready)
        {
            Assert.Equal(ArticleRelationPermissionState.Denied, Assert.Single(page.Items).Article.EditPermission);
        }
        else
        {
            Assert.Empty(page.Items);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task MetadataPagination_UsesBoundedRowsAndZeroSourceBodies(int count)
    {
        var fixture = await Fixture.CreateAsync(count);
        BlockTargetArticleQueryPage page = await fixture.Service.QueryArticlesAsync(Request(limit: 100));
        Assert.Equal(BlockTargetQueryPageStatus.Ready, page.Status);
        Assert.Equal(Math.Min(count, 100), page.Items.Count);
        Assert.Equal([101], fixture.Source.ArticlePageReads);
        Assert.Equal(0, fixture.Source.HeadingReads);
        Assert.Empty(fixture.Relations.ArticleReads);
    }

    [Theory]
    [InlineData("中文", "中文标题")]
    [InlineData("العربية", "عنوان العربية")]
    [InlineData("CASE", "case title")]
    public async Task Search_ReturnsBoundedOrdinalCaseInsensitiveMetadata(string search, string title)
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.Articles = [fixture.Source.Articles[0] with { Title = title }];
        BlockTargetQueryRequest request = Seal(Request() with
        {
            Search = search
        });
        Assert.Equal(title, Assert.Single((await fixture.Service.QueryArticlesAsync(request)).Items).Title);
    }

    [Fact]
    public async Task SourceErrorsAndUnavailablePermissions_ReturnSameContentFreeShape()
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.Unavailable = true;
        BlockTargetArticleQueryPage unavailable = await fixture.Service.QueryArticlesAsync(Request());
        fixture.Source.Unavailable = false;
        fixture.Source.Throw = true;
        Assert.Equal(unavailable, await fixture.Service.QueryArticlesAsync(Request()));
        AssertUnavailable(unavailable);
    }

    [Fact]
    public async Task RealIndexSourceGenerationDrift_RefusesPreparedPage()
    {
        var fixture = await Fixture.CreateAsync();
        fixture.Source.AfterRead = () => fixture.Relations.Generation++;
        AssertUnavailable(await fixture.Service.QueryArticlesAsync(Request()));
    }

    [Fact]
    public async Task CancellationAndCursorTamper_DoNotMintSelectablePages()
    {
        var fixture = await Fixture.CreateAsync(2);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        BlockTargetQueryRequest request = Request(limit: 1);
        BlockTargetArticleQueryPage cancelled = await fixture.Service.QueryArticlesAsync(request, cancellationToken: cancellation.Token);
        Assert.Equal(BlockTargetQueryPageStatus.Cancelled, cancelled.Status);
        Assert.Empty(cancelled.Items);
        Assert.True(BlockTargetQueryValidator.Validate(cancelled, request).IsValid);
        BlockTargetQueryCursor cursor = (await fixture.Service.QueryArticlesAsync(request)).Next!;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Service.QueryArticlesAsync(request, cursor with { Continuation = Article(999) }));
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Service.QueryHeadingsAsync(request));
    }

    private static void AssertUnavailable(BlockTargetArticleQueryPage page)
    {
        Assert.Equal(BlockTargetQueryPageStatus.Unavailable, page.Status);
        Assert.Empty(page.Items);
        Assert.Null(page.Next);
    }

    private static BlockTargetQueryRequest Seal(BlockTargetQueryRequest request)
        => request with
        {
            RequestDigest = BlockTargetQueryDigest.ComputeRequest(request)
        };

    private static string Article(int id) => $"article:20000000-0000-4000-8000-{id:x12}";
    private static string Revision(int id) => $"revision:30000000-0000-4000-8000-{id:x12}";
    private static string Heading(int id) => $"heading:40000000-0000-4000-8000-{id:x12}";

    private static BlockTargetArticleCoordinate Coordinate(int id)
        => new(Article(id), Revision(id), 1, ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published,
            ArticleRelationPermissionState.Allowed, ArticleRelationPermissionState.Allowed, Digest, $"article-{id}");

    private static BlockTargetQueryRequest Request(BlockTargetQueryLayer layer = BlockTargetQueryLayer.Articles,
        BlockTargetArticleCoordinate? article = null, int limit = 100)
        => Seal(new BlockTargetQueryRequest(BlockTargetQuerySchemas.Request, 1, s_coordinate,
            layer, BlockTargetQueryScope.AuthoringCurrent, article, string.Empty, limit, 1, string.Empty));

    private static ArticleBlockTargetQueryObservation Changed(ArticleBlockTargetQueryObservation observation, string fault)
        => observation with
        {
            Coordinate = observation.Coordinate with
            {
                PermissionRevision = fault == "permission" ? 8 : observation.Coordinate.PermissionRevision,
                QueryRevision = fault == "query" ? 12 : observation.Coordinate.QueryRevision,
                IndexRevision = fault == "index" ? 14 : observation.Coordinate.IndexRevision,
                RouteRevision = fault == "route" ? 18 : observation.Coordinate.RouteRevision,
                ActorIdentity = fault == "actor" ? "actor:other" : observation.Coordinate.ActorIdentity,
                SiteIdentity = fault == "site" ? "site:other" : observation.Coordinate.SiteIdentity,
                PermissionContextDigest = fault == "permission-context" ? OtherDigest : observation.Coordinate.PermissionContextDigest
            },
            Scope = fault == "scope" ? BlockTargetQueryScope.CurrentPublicPublication : observation.Scope,
            SourceGeneration = fault == "source-generation" ? 2 : observation.SourceGeneration,
            IndexGeneration = fault == "index-generation" ? 2 : observation.IndexGeneration
        };

    /// <summary>Controlled authority facts are fixtures, not a production identity/permission/parser adapter.</summary>
    private sealed class QuerySource(int articleCount, int headingCount) : IArticleBlockTargetQuerySource
    {
        public ArticleBlockTargetQueryObservation Observation { get; set; } = new(s_coordinate, BlockTargetQueryScope.AuthoringCurrent, 1, 1);
        public ImmutableArray<BlockTargetArticleQueryItem> Articles
        {
            get; set;
        } = Enumerable.Range(1, articleCount)
            .Select(static id => new BlockTargetArticleQueryItem(Coordinate(id), $"Article {id}", id)).ToImmutableArray();
        public List<int> ArticlePageReads { get; } = [];
        public string? ArticleFault
        {
            get; set;
        }
        public string? SelectedFault
        {
            get; set;
        }
        public string? HeadingFault
        {
            get; set;
        }
        public BlockTargetInventoryDiagnostic Diagnostic
        {
            get; set;
        }
        public bool Unavailable
        {
            get; set;
        }
        public bool Throw
        {
            get; set;
        }
        public int HeadingReads
        {
            get; private set;
        }
        public Action? AfterRead
        {
            get; set;
        }

        public Task<ArticleBlockTargetQueryObservation?> ObserveAsync(ArticleRelationActorContext actor,
            BlockTargetQueryScope scope, CancellationToken cancellationToken)
            => Task.FromResult(Unavailable ? null : Observation);

        public Task<ArticleBlockTargetQueryArticleBatch> ReadArticlesAsync(ArticleBlockTargetQueryObservation observation,
            string search, string? afterArticleIdentity, int pageSize, CancellationToken cancellationToken)
        {
            if (Throw)
            {
                throw new InvalidOperationException("private source/title must not escape");
            }
            ArticlePageReads.Add(pageSize);
            ImmutableArray<BlockTargetArticleQueryItem> items = Articles.Where(item =>
                (afterArticleIdentity is null || StringComparer.Ordinal.Compare(item.Article.ArticleIdentity, afterArticleIdentity) > 0)
                && item.Title.Contains(search, StringComparison.OrdinalIgnoreCase)).Take(pageSize).ToImmutableArray();
            items = ArticleFault switch
            {
                "duplicate" => [items[0], items[0]],
                "reordered" => items.Reverse().ToImmutableArray(),
                "oversized" => Enumerable.Repeat(items[0], pageSize + 1).ToImmutableArray(),
                "private-lookahead" => items.SetItem(items.Length - 1, items[^1] with { Article = items[^1].Article with { Permission = ArticleRelationPermissionState.Denied } }),
                "stale-content" => [items[0] with { Article = items[0].Article with { ContentDigest = OtherDigest } }],
                "stale-revision" => [items[0] with { Article = items[0].Article with { RevisionNumber = 2 } }],
                "unindexed" => [items[0] with { Article = Coordinate(999) }],
                "default" => default,
                _ => items
            };
            AfterRead?.Invoke();
            return Task.FromResult(new ArticleBlockTargetQueryArticleBatch(
                ArticleFault == "foreign-observation" ? Changed(observation, "route") : observation, items));
        }

        public Task<ArticleBlockTargetQueryArticleRead> ReadArticleAsync(ArticleBlockTargetQueryObservation observation,
            string articleIdentity, CancellationToken cancellationToken)
        {
            BlockTargetArticleQueryItem? item = Articles.SingleOrDefault(item => item.Article.ArticleIdentity == articleIdentity);
            if (item is not null)
            {
                item = SelectedFault switch
                {
                    "missing" => null,
                    "denied" => item with { Article = item.Article with { Permission = ArticleRelationPermissionState.Denied } },
                    "readonly" => item with { Article = item.Article with { EditPermission = ArticleRelationPermissionState.Denied } },
                    "archived" => item with { Article = item.Article with { Lifecycle = ArticleRelationLifecycleState.Archived } },
                    "deleted" => item with { Article = item.Article with { Lifecycle = ArticleRelationLifecycleState.Deleted } },
                    "changed-route" => item with { Article = item.Article with { CanonicalSlug = "changed-route" } },
                    "changed-revision" => item with { Article = item.Article with { RevisionNumber = 2 } },
                    _ => item
                };
            }
            return Task.FromResult(new ArticleBlockTargetQueryArticleRead(observation, item));
        }

        public Task<ArticleBlockTargetQueryHeadingBatch> ReadHeadingsAsync(ArticleBlockTargetQueryObservation observation,
            BlockTargetArticleCoordinate article, string search, string? afterHeadingIdentity, int pageSize,
            CancellationToken cancellationToken)
        {
            HeadingReads++;
            ImmutableArray<BlockTargetHeadingQueryItem> items = Diagnostic == BlockTargetInventoryDiagnostic.None
                ? Enumerable.Range(1, headingCount).Select(id => new BlockTargetHeadingQueryItem(article, Heading(id),
                    $"node:{id}", id * 20, id * 20 + 10, $"Heading {id}"))
                    .Where(item => (afterHeadingIdentity is null || StringComparer.Ordinal.Compare(item.HeadingIdentity, afterHeadingIdentity) > 0)
                        && item.DisplayText.Contains(search, StringComparison.OrdinalIgnoreCase)).Take(pageSize).ToImmutableArray() : [];
            items = HeadingFault switch
            {
                "duplicate" => [items[0], items[0]],
                "reordered" => items.Reverse().ToImmutableArray(),
                "oversized" => Enumerable.Repeat(items[0], pageSize + 1).ToImmutableArray(),
                "article" => [items[0] with { Article = Coordinate(999) }],
                "range" => [items[0] with { SourceEnd = items[0].SourceStart }],
                "outside-source" => [items[0] with { SourceEnd = 100_001 }],
                _ => items
            };
            AfterRead?.Invoke();
            return Task.FromResult(new ArticleBlockTargetQueryHeadingBatch(observation, article,
                100_000,
                HeadingFault == "unknown-diagnostic" ? (BlockTargetInventoryDiagnostic)255
                    : HeadingFault == "blocked-content" ? BlockTargetInventoryDiagnostic.Duplicate : Diagnostic, items));
        }
    }

    private sealed class RelationSource(ImmutableArray<ArticleRelationIndexArticle> articles) : IArticleRelationIndexSource
    {
        public long Generation { get; set; } = 1;
        public List<int> PageReads { get; } = [];
        public List<string> ArticleReads { get; } = [];

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageReads.Add(pageSize);
            ImmutableArray<ArticleRelationIndexArticle> remaining = articles
                .Where(article => afterArticleIdentity is null || StringComparer.Ordinal.Compare(article.ArticleIdentity, afterArticleIdentity) > 0)
                .Take(pageSize + 1).ToImmutableArray();
            return Task.FromResult(new ArticleRelationIndexSourcePage(actor, Generation, remaining.Take(pageSize).ToImmutableArray(), remaining.Length > pageSize));
        }

        public Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleReads.Add(articleIdentity);
            return Task.FromResult(new ArticleRelationIndexArticleRead(actor, Generation,
                articles.Single(article => article.ArticleIdentity == articleIdentity)));
        }
    }

    private sealed record Fixture(QuerySource Source, RelationSource Relations, ArticleRelationIndex Index, ArticleBlockTargetQueryService Service)
    {
        public static async Task<Fixture> CreateAsync(int articleCount = 1, int headingCount = 1,
            bool publication = false, ArticleRelationLifecycleState lifecycle = ArticleRelationLifecycleState.Published)
        {
            var source = new QuerySource(articleCount, headingCount);
            if (publication)
            {
                source.Observation = source.Observation with
                {
                    Scope = BlockTargetQueryScope.CurrentPublicPublication
                };
                source.Articles = source.Articles.Select(item => item with
                {
                    Article = item.Article with
                    {
                        RevisionKind = ArticleRelationRevisionKind.Published,
                        Lifecycle = lifecycle,
                        EditPermission = ArticleRelationPermissionState.Denied
                    }
                }).ToImmutableArray();
            }
            ImmutableArray<ArticleRelationIndexArticle> families = source.Articles.Select(item =>
            {
                var facts = new ArticleRelationSourceFacts(item.Article.ArticleIdentity, item.Article.RevisionIdentity,
                    item.Article.RevisionNumber, item.Article.RevisionKind,
                    publication ? ArticleRelationLifecycleState.Published : item.Article.Lifecycle,
                    ArticleRelationPermissionState.Allowed, s_actor, item.Article.ContentDigest);
                ArticleRelationSet set = ArticleRelationContractValidator.Seal(new ArticleRelationSet(
                    ArticleRelationSchemas.RelationSet, 1, facts, [], string.Empty));
                return new ArticleRelationIndexArticle(item.Article.ArticleIdentity, 1, [set]);
            }).ToImmutableArray();
            var relations = new RelationSource(families);
            var index = new ArticleRelationIndex(relations, s_actor);
            await index.RebuildAsync(0);
            return new(source, relations, index, new(index, source));
        }
    }
}
