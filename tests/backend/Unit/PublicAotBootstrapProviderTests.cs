using System.Reflection;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBootstrapProviderTests
{
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
}
