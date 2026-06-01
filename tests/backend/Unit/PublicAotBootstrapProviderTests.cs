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

    private static string ReadProviderSource()
        => File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs"));

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
