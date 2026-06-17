using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminConsistencyContractTests
{
    [Fact]
    public void AdminTaxonomyRoutes_ReturnManagementCountsAndTagDeleteDoesNotUnlinkArticles()
    {
        string authoring = ReadRepoFile("src", "backend", "Modules", "Endpoints", "AuthoringEndpoints.cs");
        string taxonomy = ReadRepoFile("src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.Taxonomy.cs");
        string dto = ReadRepoFile("src", "backend", "Models", "Dtos", "AuthoringDtos.cs");

        Assert.Contains("MapGet(\"/taxonomy/categories\"", authoring, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/taxonomy/tags\"", authoring, StringComparison.Ordinal);
        Assert.Contains("AdminCategoryItemResponse", dto, StringComparison.Ordinal);
        Assert.Contains("AdminTagItemResponse", dto, StringComparison.Ordinal);
        Assert.Contains("TotalBlockingArticleCount", dto, StringComparison.Ordinal);
        Assert.Contains("AnyAsync(at => at.TagId == id)", taxonomy, StringComparison.Ordinal);
        Assert.DoesNotContain("Deleteable<ArticleTag>().Where(at => at.TagId == id)", taxonomy, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminUserStatusAndSystemMessageEndpoints_RejectUnsupportedContractValues()
    {
        string users = ReadRepoFile("src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.AdminUsers.cs");
        string messages = ReadRepoFile("src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.Messages.cs");

        Assert.Contains("request.Status is not 0 and not 1", users, StringComparison.Ordinal);
        Assert.Contains("用户状态变更仅允许封禁或解封", users, StringComparison.Ordinal);
        Assert.Contains("!request.TargetUserId.HasValue || request.TargetUserId.Value <= 0", messages, StringComparison.Ordinal);
        Assert.Contains("系统消息必须指定目标用户", messages, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticPageAdminEndpoints_UseSameSlugAllowlistAsPublicReads()
    {
        string system = ReadRepoFile("src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.System.cs");

        Assert.Contains("MapGet(\"/system/page/{slug}\"", system, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/system/admin/page/{slug}\"", system, StringComparison.Ordinal);
        Assert.Contains("AllowedPageSlugs.Contains(dto.Slug ?? string.Empty)", system, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/system/page/refresh/{slug}\"", system, StringComparison.Ordinal);
        Assert.Contains("页面标识 (Slug) 不在可管理静态页范围内", system, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(params string[] segments)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, Path.Combine(segments)));
}
