using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBootstrapProviderTests
{
    [Fact]
    public async Task SeoSnapshot_SerializesReadsThatShareOneScopedSystemService()
    {
        ISystemService systemService = Substitute.For<ISystemService>();
        var seoStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var seoResult = new TaskCompletionSource<SeoConfigReadModel>(TaskCreationOptions.RunContinuationsAsynchronously);
        var complianceStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var complianceResult = new TaskCompletionSource<SiteComplianceConfigReadModel>(TaskCreationOptions.RunContinuationsAsynchronously);
        systemService.GetSeoConfigAsync().Returns(_ =>
        {
            seoStarted.TrySetResult(true);
            return seoResult.Task;
        });
        systemService.GetSiteComplianceConfigAsync().Returns(_ =>
        {
            complianceStarted.TrySetResult(true);
            return complianceResult.Task;
        });
        await using ServiceProvider provider = new ServiceCollection()
            .AddScoped(_ => systemService)
            .BuildServiceProvider();
        var snapshot = new AotSeoConfigSnapshot(provider.GetRequiredService<IServiceScopeFactory>());

        Task<PublicAotSeoSnapshot> read = snapshot.GetAsync();
        await seoStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        await systemService.DidNotReceive().GetSiteComplianceConfigAsync();
        seoResult.SetResult(new SeoConfigReadModel
        {
            Title = "Scoped SEO",
            Description = "serialized reads",
            BaseUrl = "https://example.test"
        });
        await complianceStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        complianceResult.SetResult(new SiteComplianceConfigReadModel { Enabled = true });

        PublicAotSeoSnapshot result = await read.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal("Scoped SEO", result.SiteTitle);
        await systemService.Received(1).GetSeoConfigAsync();
        await systemService.Received(1).GetSiteComplianceConfigAsync();
    }

    [Fact]
    public async Task HomeProvider_CarriesFirstPageCursorIntoSnapshot()
    {
        IArticleService articles = Substitute.For<IArticleService>();
        IAotSeoConfigSnapshot seo = Substitute.For<IAotSeoConfigSnapshot>();
        using var cts = new CancellationTokenSource();
        articles.GetPageListAsync(Arg.Is<ArticlePageQuery>(query => query.Page == 1 && query.Size == 10), cts.Token)
            .Returns(Result<CorePageResult<ArticleListCoreModel>>.Success(
                new CorePageResult<ArticleListCoreModel>([], 21, "cursor_home_2", true)));
        articles.GetFeaturedArticlesAsync(new ArticleCountQuery(3), cts.Token)
            .Returns(Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success([]));
        articles.GetHotArticlesAsync(new ArticleCountQuery(5), cts.Token)
            .Returns(Result<IReadOnlyList<PopularArticleCoreModel>>.Success([]));
        seo.GetAsync(cts.Token).Returns(new PublicAotSeoSnapshot("Fsus", "Blog", "https://example.test"));
        var provider = new PublicAotHomeBootstrapProvider(articles, seo);
        var match = new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, "home", "/", "/", string.Empty);

        var result = await provider.BuildSnapshotAsync(match, cts.Token);

        Assert.True(result.IsSuccess, result.Error.Message);
        PublicHomePageSnapshot snapshot = Assert.IsType<PublicHomePageSnapshot>(result.Value);
        Assert.Equal(1, snapshot.Page);
        Assert.Equal(21, snapshot.Total);
        Assert.Equal("cursor_home_2", snapshot.NextCursor);
        Assert.True(snapshot.HasMore);
        await articles.Received(1).GetPageListAsync(
            Arg.Is<ArticlePageQuery>(query =>
                query.Page == 1 &&
                query.Size == 10 &&
                query.CategoryId == null &&
                query.TagId == null &&
                !query.IsDeleted &&
                query.Status == null &&
                !query.IncludePrivate &&
                query.Keyword == null &&
                query.ListCacheVersion == null &&
                !query.UseSourceCache &&
                query.Cursor == null),
            cts.Token);
        await articles.Received(1).GetFeaturedArticlesAsync(new ArticleCountQuery(3), cts.Token);
        await articles.Received(1).GetHotArticlesAsync(new ArticleCountQuery(5), cts.Token);
    }

    [Fact]
    public async Task HomeProvider_RejectsDeepPageBeforeAnyRead()
    {
        IArticleService articles = Substitute.For<IArticleService>();
        IAotSeoConfigSnapshot seo = Substitute.For<IAotSeoConfigSnapshot>();
        var provider = new PublicAotHomeBootstrapProvider(articles, seo);
        var match = new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, "home:page:3", "/", "/", "?page=3")
        {
            Page = 3
        };

        var result = await provider.BuildSnapshotAsync(match);

        Assert.True(result.IsFailure);
        Assert.Equal(FsusBlog.Core.Common.ErrorCode.Validation, result.Error.Code);
        Assert.Equal("public_aot_cursor_required", result.Error.Message);
        await articles.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
        await articles.DidNotReceive().GetFeaturedArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(typeof(PublicAotHomeBootstrapProvider))]
    [InlineData(typeof(PublicAotFilterBootstrapProvider))]
    public void PaginatedProviders_RejectCursorlessDeepSnapshotRequests(Type provider)
    {
        string build = RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync");

        Assert.Contains("AllowsStaticArtifact", build, StringComparison.Ordinal);
        Assert.DoesNotContain("ParsePageRouteKey", build, StringComparison.Ordinal);
        Assert.Contains("public_aot_cursor_required", build, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailProvider_RuntimeUsesPublicOnlyProjection()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(PublicAotArticleDetailBootstrapProvider),
            "LoadPublicArticleForAotAsync");
        Type projection = typeof(PublicAotArticleDetailBootstrapProvider).GetNestedType(
            "ArticleDetailAotProjection",
            BindingFlags.NonPublic)!;

        Assert.Contains("LoadPublicArticleForAotAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ArticleBody.get_MarkdownContent", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_IsDeleted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_Status", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_PublishedAt", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_PublicUpdatedAt", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_ScheduledPublishAt", runtimeShape, StringComparison.Ordinal);
        Assert.Equal(typeof(string), projection.GetProperty("Content")!.PropertyType);
        Assert.DoesNotContain("includePrivate", runtimeShape, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ArticleDetailProvider_RuntimeDoesNotProjectAdminRevisionActorAsPublicAuthor()
    {
        Type provider = typeof(PublicAotArticleDetailBootstrapProvider);
        string runtimeShape = RuntimeMetadataInspection.DescribeType(provider);
        Type projectionType = provider.GetNestedType("ArticleDetailAotProjection", BindingFlags.NonPublic)!;
        object projection = Activator.CreateInstance(projectionType, nonPublic: true)!;
        MethodInfo resolveAuthor = provider.GetMethod("ResolveArticleAuthorName", BindingFlags.NonPublic | BindingFlags.Static)!;
        var seo = new PublicAotSeoSnapshot("Fsus Blog", "description", "https://example.test", SiteAuthor: "Public Author");

        Assert.Equal(string.Empty, projectionType.GetProperty("AuthorName")!.GetValue(projection));
        Assert.Equal("Public Author", resolveAuthor.Invoke(null, [string.Empty, seo]));
        Assert.Null(provider.GetNestedType("ArticleAuthorAotProjection", BindingFlags.NonPublic));
        Assert.DoesNotContain("User.get_PublicHandle", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("User.get_InternalSubject", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ResolveArticleAuthorName", RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync"), StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailProvider_RuntimeLoadsRightsSnapshotAndFailsClosedWhenMissing()
    {
        Type provider = typeof(PublicAotArticleDetailBootstrapProvider);
        string rightsLoad = RuntimeMetadataInspection.DescribeMethods(provider, "LoadArticleRightsForAotAsync");
        string build = RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync");
        MethodInfo complete = provider.GetMethod("HasCompleteArticleRights", BindingFlags.NonPublic | BindingFlags.Static)!;
        var missing = new ArticleRightsReadModel();
        var populated = new ArticleRightsReadModel
        {
            SnapshotId = 1,
            ArticleRevisionId = 2,
            RevisionNo = 3,
            LicenseType = "all-rights-reserved",
            CopyPolicy = "append-attribution",
            PolicyHash = "policy-hash",
            ContentCanonicalHash = "content-hash"
        };

        Assert.Contains("article_rights_snapshot", rightsLoad, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", rightsLoad, StringComparison.Ordinal);
        Assert.False((bool)complete.Invoke(null, [missing])!);
        Assert.True((bool)complete.Invoke(null, [populated])!);
        Assert.Contains("HasCompleteArticleRights", build, StringComparison.Ordinal);
        Assert.Contains("public_aot_article_rights_missing", build, StringComparison.Ordinal);
    }

    [Fact]
    public void ArchiveProvider_RuntimeUsesMinimalProjectionInsteadOfFullArticleDtoPaging()
    {
        Type provider = typeof(PublicAotArchiveBootstrapProvider);
        string runtimeShape = RuntimeMetadataInspection.DescribeType(provider);
        Type projection = provider.GetNestedType("ArchiveArticleAotProjection", BindingFlags.NonPublic)!;
        ConstructorInfo constructor = Assert.Single(provider.GetConstructors());

        Assert.NotNull(projection);
        Assert.Contains("ListPublicArchiveArticlesAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_Status", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_PublishedAt", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain(constructor.GetParameters(), static parameter => parameter.ParameterType == typeof(IArticleService));
        Assert.DoesNotContain("GetPageListAsync", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void FilterProvider_InvalidTaxonomyFailsNotFoundInsteadOfBuildingEmptySuccessPage()
    {
        Type provider = typeof(PublicAotFilterBootstrapProvider);
        string build = RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync");

        Assert.Contains("FilterIdentity.get_IsInvalidTarget", build, StringComparison.Ordinal);
        Assert.Contains("public_aot_filter_not_found", build, StringComparison.Ordinal);
    }

    [Fact]
    public void FilterProvider_TagNameCompatibilityResolvesCurrentAndPersistedAliasesToStableId()
    {
        Type provider = typeof(PublicAotFilterBootstrapProvider);
        string resolver = RuntimeMetadataInspection.DescribeMethods(provider, "ResolveTagIdByNameAsync");

        Assert.Contains("Tag.get_Name", resolver, StringComparison.Ordinal);
        Assert.Contains("Tag.get_Description", resolver, StringComparison.Ordinal);
        Assert.Contains("TagUrlAlias.get_NormalizedName", resolver, StringComparison.Ordinal);
        Assert.Contains("TagUrlAlias.get_TagId", resolver, StringComparison.Ordinal);
        Assert.Contains("NormalizeLookupKey", resolver, StringComparison.Ordinal);
    }

    [Fact]
    public void FilterProvider_ResolvesNameAndDescriptionInTheSameIdentityLookup()
    {
        Type provider = typeof(PublicAotFilterBootstrapProvider);
        string identity = RuntimeMetadataInspection.DescribeMethods(provider, "ResolveFilterIdentityAsync");
        string tagByName = RuntimeMetadataInspection.DescribeMethods(provider, "ResolveTagIdByNameAsync");
        string typeShape = RuntimeMetadataInspection.DescribeType(provider);
        Type projection = provider.GetNestedType("FilterTaxonomyAotProjection", BindingFlags.NonPublic)!;
        Type identityType = provider.GetNestedType("FilterIdentity", BindingFlags.NonPublic)!;

        Assert.Contains("Category.get_Name", identity, StringComparison.Ordinal);
        Assert.Contains("Category.get_Description", identity, StringComparison.Ordinal);
        Assert.Contains("Tag.get_Name", identity, StringComparison.Ordinal);
        Assert.Contains("Tag.get_Description", identity, StringComparison.Ordinal);
        Assert.Contains("NormalizeFilterDescription", identity, StringComparison.Ordinal);
        Assert.Contains("Tag.get_Description", tagByName, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadFilterDescription", typeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("GetDescriptionAsync", typeShape, StringComparison.Ordinal);
        Assert.Equal(typeof(string), projection.GetProperty("Name")!.PropertyType);
        Assert.Equal(typeof(string), projection.GetProperty("Description")!.PropertyType);
        Assert.Equal(typeof(string), identityType.GetProperty("Description")!.PropertyType);
        Assert.Contains("FilterIdentity.get_Description", RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync"), StringComparison.Ordinal);
    }
}
