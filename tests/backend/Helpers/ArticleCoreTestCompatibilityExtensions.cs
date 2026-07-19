using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Compatibility;

internal static class ArticleCoreTestCompatibilityExtensions
{
    public static Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(
        this IArticleCoreService service,
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        int? status = null,
        bool includePrivate = false,
        string? keyword = null,
        long? listCacheVersion = null,
        CancellationToken cancellationToken = default)
        => service.GetPageListAsync(new ArticlePageQuery(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword, listCacheVersion), cancellationToken);

    public static Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(this IArticleCoreService service, int id, bool includePrivate = false, CancellationToken cancellationToken = default)
        => service.GetByIdAsync(new ArticleDetailQuery(id, includePrivate), cancellationToken);

    public static Task<Result<int>> CreateAsync(this IArticleCoreService service, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => service.CreateAsync(new CreateArticleCommand(new ArticleWriteRequestCoreModel(title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt)), cancellationToken);

    public static Task<Result> UpdateAsync(this IArticleCoreService service, int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => service.UpdateAsync(new UpdateArticleCommand(id, new ArticleWriteRequestCoreModel(title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt)), cancellationToken);

    public static Task<Result> DeleteAsync(this IArticleCoreService service, int id, CancellationToken cancellationToken = default)
        => service.DeleteAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<Result> RestoreAsync(this IArticleCoreService service, int id, CancellationToken cancellationToken = default)
        => service.RestoreAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<Result> PermanentlyDeleteArticleAsync(this IArticleCoreService service, int id, CancellationToken cancellationToken = default)
        => service.PermanentlyDeleteArticleAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(this IArticleCoreService service, string keyword, CancellationToken cancellationToken = default)
        => service.SearchArticlesAsync(new ArticleSearchQuery(keyword), cancellationToken);

    public static Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(this IArticleCoreService service, int count = 10, CancellationToken cancellationToken = default)
        => service.GetHotArticlesAsync(new ArticleCountQuery(count), cancellationToken);

    public static Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(this IArticleCoreService service, int count, CancellationToken cancellationToken = default)
        => service.GetFeaturedArticlesAsync(new ArticleCountQuery(count), cancellationToken);

    public static ValueTask<Result> IncreaseViewCountAsync(this IArticleCoreService service, int id)
        => service.IncreaseViewCountAsync(new ArticleViewCountCommand(id));

    public static ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(this IArticleCoreService service, IReadOnlyDictionary<int, int> articleCounts, CancellationToken cancellationToken = default)
        => service.IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(articleCounts), cancellationToken);

    public static Task<CorePageResult<ArticleListCoreModel>> GetPageListAsync(this IArticleCoreGateway gateway, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string? keyword = null, long? listCacheVersion = null, CancellationToken cancellationToken = default)
        => gateway.GetPageListAsync(new ArticlePageQuery(page, size, categoryId, tagId, isDeleted, status, includePrivate, keyword, listCacheVersion), cancellationToken);

    public static Task<ArticleDetailCoreModel?> GetByIdAsync(this IArticleCoreGateway gateway, int id, bool includePrivate = false, CancellationToken cancellationToken = default)
        => gateway.GetByIdAsync(new ArticleDetailQuery(id, includePrivate), cancellationToken);

    public static Task<int> CreateAsync(this IArticleCoreGateway gateway, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => gateway.CreateAsync(new CreateArticleCommand(new ArticleWriteRequestCoreModel(title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt)), cancellationToken);

    public static Task<bool> UpdateAsync(this IArticleCoreGateway gateway, int id, string title, string content, string? summary, string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, int status = 2, DateTime? scheduledPublishAt = null, CancellationToken cancellationToken = default)
        => gateway.UpdateAsync(new UpdateArticleCommand(id, new ArticleWriteRequestCoreModel(title, content, summary, coverImageUrl, categoryId, tagIds, status, scheduledPublishAt)), cancellationToken);

    public static Task<bool> DeleteAsync(this IArticleCoreGateway gateway, int id, CancellationToken cancellationToken = default)
        => gateway.DeleteAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<bool> RestoreAsync(this IArticleCoreGateway gateway, int id, CancellationToken cancellationToken = default)
        => gateway.RestoreAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<bool> PermanentlyDeleteArticleAsync(this IArticleCoreGateway gateway, int id, CancellationToken cancellationToken = default)
        => gateway.PermanentlyDeleteArticleAsync(new ArticleIdCommand(id), cancellationToken);

    public static Task<IReadOnlyList<ArticleListCoreModel>> SearchArticlesAsync(this IArticleCoreGateway gateway, string keyword, CancellationToken cancellationToken = default)
        => gateway.SearchArticlesAsync(new ArticleSearchQuery(keyword), cancellationToken);

    public static Task<IReadOnlyList<PopularArticleCoreModel>> GetHotArticlesAsync(this IArticleCoreGateway gateway, int count, CancellationToken cancellationToken = default)
        => gateway.GetHotArticlesAsync(new ArticleCountQuery(count), cancellationToken);

    public static Task<IReadOnlyList<FeaturedArticleCoreModel>> GetFeaturedArticlesAsync(this IArticleCoreGateway gateway, int count, CancellationToken cancellationToken = default)
        => gateway.GetFeaturedArticlesAsync(new ArticleCountQuery(count), cancellationToken);

    public static ValueTask IncreaseViewCountAsync(this IArticleCoreGateway gateway, int id)
        => gateway.IncreaseViewCountAsync(new ArticleViewCountCommand(id));

    public static ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(this IArticleCoreGateway gateway, IReadOnlyDictionary<int, int> articleCounts, CancellationToken cancellationToken = default)
        => gateway.IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(articleCounts), cancellationToken);

    public static Task<int> CreateAsync(this ArticleService service, CreateArticleRequest request, CancellationToken cancellationToken = default)
        => service.CreateAsync(ToCore(request), cancellationToken);

    public static Task<bool> UpdateAsync(this ArticleService service, int id, UpdateArticleRequest request, CancellationToken cancellationToken = default)
        => service.UpdateAsync(id, ToCore(request), cancellationToken);

    private static ArticleWriteRequestCoreModel ToCore(CreateArticleRequest request)
        => new(request.Title, request.Content, request.Summary, request.CoverImageUrl, request.CategoryId, request.TagIds ?? [], (int)request.Status, request.ScheduledPublishAt, ToCore(request.Rights), ResolveRightsMutation(request.Rights, request.ResetRights));

    private static ArticleWriteRequestCoreModel ToCore(UpdateArticleRequest request)
        => new(request.Title, request.Content, request.Summary, request.CoverImageUrl, request.CategoryId, request.TagIds ?? [], (int)request.Status, request.ScheduledPublishAt, ToCore(request.Rights), ResolveRightsMutation(request.Rights, request.ResetRights));

    private static ArticleRightsMutationMode ResolveRightsMutation(ArticleRightsRequest? request, bool resetRights)
        => resetRights
            ? ArticleRightsMutationMode.Reset
            : request is null
                ? ArticleRightsMutationMode.Preserve
                : ArticleRightsMutationMode.Replace;

    private static ArticleRightsRequestCoreModel? ToCore(ArticleRightsRequest? request)
        => request is null ? null : new ArticleRightsRequestCoreModel(
            request.Enabled,
            request.LicenseType ?? "all-rights-reserved",
            request.CopyrightHolder,
            request.CopyrightYear,
            request.RightsStatement,
            request.AttributionTemplate,
            request.CopyPolicy ?? "append-attribution",
            request.MaxExcerptChars,
            request.AllowCodeCopy,
            request.ShowPublicBadge,
            request.ProofBindingEnabled);
}
