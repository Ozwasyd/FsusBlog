using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBootstrapProviderTests
{
    [Fact]
    public void ArticleDetailProvider_SourceUsesPublicOnlyProjection()
    {
        string source = ReadProviderSource();

        Assert.Contains("LoadPublicArticleForAotAsync", source);
        Assert.Contains("ArticleBody", source);
        Assert.Contains("ArticleStatus.Published", source);
        Assert.Contains("ScheduledPublishAt", source);
        Assert.DoesNotContain("includePrivate: true", source);
    }

    [Fact]
    public void ArticleDetailProvider_SourceDoesNotProjectAdminRevisionActorAsPublicAuthor()
    {
        string source = ReadProviderSource();
        string articleProviderSource = source[source.IndexOf("public sealed class PublicAotArticleDetailBootstrapProvider", StringComparison.Ordinal)..];

        Assert.Contains("projection.AuthorName = string.Empty", articleProviderSource);
        Assert.DoesNotContain("ArticleAuthorAotProjection", articleProviderSource);
        Assert.DoesNotContain(".LeftJoin<User>", articleProviderSource);
        Assert.DoesNotContain("user.PublicHandle", articleProviderSource);
        Assert.DoesNotContain("user.InternalSubject", articleProviderSource);
        Assert.Contains("ResolveArticleAuthorName(article.AuthorName, seo)", articleProviderSource);
    }

    [Fact]
    public void ArticleDetailProvider_SourceLoadsRightsSnapshotAndFailsClosedWhenMissing()
    {
        string source = ReadProviderSource();
        string articleProviderSource = source[source.IndexOf("public sealed class PublicAotArticleDetailBootstrapProvider", StringComparison.Ordinal)..];

        Assert.Contains("article_rights_snapshot", articleProviderSource);
        Assert.Contains("article_rights_proof", articleProviderSource);
        Assert.Contains("HasCompleteArticleRights(article.Rights)", articleProviderSource);
        Assert.Contains("public_aot_article_rights_missing", articleProviderSource);
    }

    [Fact]
    public void ArchiveProvider_SourceUsesMinimalProjectionInsteadOfFullArticleDtoPaging()
    {
        string source = ReadProviderSource();
        string archiveProviderSource = source[source.IndexOf("public sealed class PublicAotArchiveBootstrapProvider", StringComparison.Ordinal)..];

        Assert.Contains("ArchiveArticleAotProjection", archiveProviderSource);
        Assert.Contains("ListPublicArchiveArticlesAsync", archiveProviderSource);
        Assert.Contains("ArticleStatus.Published", archiveProviderSource);
        Assert.DoesNotContain("IArticleService articleService", archiveProviderSource);
        Assert.DoesNotContain("GetPageListAsync", archiveProviderSource);
    }

    private static string ReadProviderSource([CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs"));
}
