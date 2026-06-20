using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReadModelProjectionHotPathContractTests
{
    [Fact]
    public void ArticleAndStatsCoreAdapters_UsePresizedLoopMappingOnHotReadPaths()
    {
        string articleAdapter = ReadRepoFile("src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs");
        string articleGateway = ReadRepoFile("src/backend/Infrastructure/CoreBridge/Gateways/ArticleCoreGateway.cs");
        string statsAdapter = ReadRepoFile("src/backend/Infrastructure/CoreBridge/Adapters/StatsServiceCoreAdapter.cs");
        string articleProjection = ReadRepoFile("src/backend/Infrastructure/Projections/ArticleProjection.cs");

        Assert.DoesNotContain(".Select(ToArticleListReadModel).ToList()", articleAdapter, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(item => new PopularArticleSummaryDto", articleAdapter, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(ToFeaturedArticleSummaryDto).ToList()", articleAdapter, StringComparison.Ordinal);
        Assert.DoesNotContain("model.Tags.Select", articleAdapter, StringComparison.Ordinal);

        Assert.DoesNotContain("source.Select(ArticleProjection.ToCoreListModel).ToList()", articleGateway, StringComparison.Ordinal);
        Assert.DoesNotContain("source.Select(ToFeaturedCoreModel).ToList()", articleGateway, StringComparison.Ordinal);

        Assert.DoesNotContain(".RecentComments.Select", statsAdapter, StringComparison.Ordinal);
        Assert.DoesNotContain(".RegionDistributions.Select", statsAdapter, StringComparison.Ordinal);
        Assert.DoesNotContain(".PopularArticles.Select", statsAdapter, StringComparison.Ordinal);

        Assert.DoesNotContain("item.Tags.Take(MaxListTags).Select", articleProjection, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Tags.Select", articleProjection, StringComparison.Ordinal);
        Assert.DoesNotContain("page.Items.Select(ToResponse).ToList()", articleProjection, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleStatusValidation_AvoidsEnumReflectionOnProjectionPaths()
    {
        string[] files =
        [
            "src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs",
            "src/backend/Infrastructure/CoreBridge/Gateways/ArticleCoreGateway.cs",
            "src/backend/Services/ArticleEndpointService.cs",
            "src/backend/Services/Authoring/AuthoringWorkflowService.cs"
        ];

        foreach (string file in files)
        {
            string source = ReadRepoFile(file);
            Assert.DoesNotContain("Enum.IsDefined(typeof(ArticleStatus)", source, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(0, ArticleStatus.Draft)]
    [InlineData(1, ArticleStatus.Scheduled)]
    [InlineData(2, ArticleStatus.Published)]
    [InlineData(3, ArticleStatus.Archived)]
    [InlineData(4, ArticleStatus.Deleted)]
    [InlineData(-1, ArticleStatus.Published)]
    [InlineData(5, ArticleStatus.Published)]
    public void ArticleStatusProjection_NormalizesOnlyKnownContiguousValues(int raw, ArticleStatus expected)
    {
        Assert.Equal(expected, ArticleStatusProjection.Normalize(raw));
        Assert.Equal(raw is >= 0 and <= 4, ArticleStatusProjection.IsDefined(raw));
    }

    [Fact]
    public void EntityAndRequestModels_DoNotAllocateDefaultEmptyNavigationOrTagLists()
    {
        string article = ReadRepoFile("src/backend/Entities/Article.cs");
        string category = ReadRepoFile("src/backend/Entities/Category.cs");
        string requests = ReadRepoFile("src/backend/Models/Requests/ArticleRequests.cs");
        string uploads = ReadRepoFile("src/backend/Models/Dtos/UploadDtos.cs");

        Assert.DoesNotContain("public List<Tag> Tags { get; set; } = [];", article, StringComparison.Ordinal);
        Assert.DoesNotContain("public List<Article> Articles { get; set; } = [];", category, StringComparison.Ordinal);
        Assert.DoesNotContain("public List<int> TagIds { get; init; } = [];", requests, StringComparison.Ordinal);
        Assert.DoesNotContain("public List<int> UploadedParts { get; init; } = [];", uploads, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleService_DoesNotAllocateTagListsForRowsWithoutTags()
    {
        string source = ReadRepoFile("src/backend/Services/ArticleService.cs");

        Assert.DoesNotContain("Tags = []", source, StringComparison.Ordinal);
        Assert.DoesNotContain("new List<TagReadModel>()", source, StringComparison.Ordinal);
        Assert.Contains("ArticleReadModelCollections.EmptyTags", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicCommentAndNonAuthUserReads_ProjectOnlyRequiredColumns()
    {
        string commentService = ReadRepoFile("src/backend/Services/CommentService.cs");
        string userService = ReadRepoFile("src/backend/Services/UserService.cs");

        Assert.Contains("private async Task<List<ThreadRootRow>> QueryThreadRootsAsync", commentService, StringComparison.Ordinal);
        Assert.Contains("GetDataReaderAsync(sql.ToString(), parameters)", commentService, StringComparison.Ordinal);
        Assert.Contains("rows.Add(new ThreadRootRow", commentService, StringComparison.Ordinal);
        Assert.Contains(".Select((c, u, ru) => new ReplyRow", commentService, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Password", commentService, StringComparison.Ordinal);
        Assert.DoesNotContain("ru.Password", commentService, StringComparison.Ordinal);

        string adminListMethod = ExtractMethodBlock(userService, "public async Task<PageResult<UserListDto>> GetAdminUserListAsync");
        Assert.Contains(".Select(u => new", adminListMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("Password", adminListMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaSecret", adminListMethod, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
