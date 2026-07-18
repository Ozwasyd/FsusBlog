using System.Reflection;

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
    public async Task HomeProvider_UsesPageSpecificSnapshotOnFirstServerRender()
    {
        IArticleService articles = Substitute.For<IArticleService>();
        IAotSeoConfigSnapshot seo = Substitute.For<IAotSeoConfigSnapshot>();
        articles.GetPageListAsync(2, 10, null, null, false, cancellationToken: Arg.Any<CancellationToken>())
            .Returns(new ArticleListPageReadModel { Items = [], Total = 21 });
        articles.GetFeaturedArticlesAsync(3, Arg.Any<CancellationToken>()).Returns([]);
        articles.GetHotArticlesAsync(5, Arg.Any<CancellationToken>()).Returns([]);
        seo.GetAsync(Arg.Any<CancellationToken>()).Returns(new PublicAotSeoSnapshot("Fsus", "Blog", "https://example.test"));
        var provider = new PublicAotHomeBootstrapProvider(articles, seo);
        var match = new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, "home:page:2", "/", "/", "?page=2")
        {
            Page = 2
        };

        var result = await provider.BuildSnapshotAsync(match);

        Assert.True(result.IsSuccess, result.Error.Message);
        PublicHomePageSnapshot snapshot = Assert.IsType<PublicHomePageSnapshot>(result.Value);
        Assert.Equal(2, snapshot.Page);
        Assert.Equal(21, snapshot.Total);
        await articles.Received(1).GetPageListAsync(2, 10, null, null, false, cancellationToken: Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task HomeProvider_ReturnsNotFoundForPageBeyondTotal()
    {
        IArticleService articles = Substitute.For<IArticleService>();
        IAotSeoConfigSnapshot seo = Substitute.For<IAotSeoConfigSnapshot>();
        articles.GetPageListAsync(3, 10, null, null, false, cancellationToken: Arg.Any<CancellationToken>())
            .Returns(new ArticleListPageReadModel { Items = [], Total = 11 });
        seo.GetAsync(Arg.Any<CancellationToken>()).Returns(new PublicAotSeoSnapshot("Fsus", "Blog", "https://example.test"));
        var provider = new PublicAotHomeBootstrapProvider(articles, seo);
        var match = new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, "home:page:3", "/", "/", "?page=3")
        {
            Page = 3
        };

        var result = await provider.BuildSnapshotAsync(match);

        Assert.True(result.IsFailure);
        Assert.Equal(FsusBlog.Core.Common.ErrorCode.NotFound, result.Error.Code);
        Assert.Equal("public_aot_page_out_of_range", result.Error.Message);
        await articles.DidNotReceive().GetFeaturedArticlesAsync(Arg.Any<int>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(typeof(PublicAotHomeBootstrapProvider))]
    [InlineData(typeof(PublicAotFilterBootstrapProvider))]
    public void PaginatedProviders_ReadNormalizedTargetPageAndRejectOverflow(Type provider)
    {
        string build = RuntimeMetadataInspection.DescribeMethods(provider, "BuildSnapshotAsync");

        Assert.Contains("PublicAotRouteMatch.get_Page", build, StringComparison.Ordinal);
        Assert.Contains("ParsePageRouteKey", build, StringComparison.Ordinal);
        Assert.Contains("public_aot_page_out_of_range", build, StringComparison.Ordinal);
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
        Assert.Contains("TagUrlAlias.get_NormalizedName", resolver, StringComparison.Ordinal);
        Assert.Contains("TagUrlAlias.get_TagId", resolver, StringComparison.Ordinal);
        Assert.Contains("NormalizeLookupKey", resolver, StringComparison.Ordinal);
    }
}
