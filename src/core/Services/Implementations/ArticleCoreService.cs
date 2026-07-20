using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class ArticleCoreService(
    IArticleCoreGateway gateway,
    TimeProvider? timeProvider = null) : IArticleCoreService
{
    private const int MaxPageSize = 100;
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    public async Task<Result<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(ArticlePageQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Page <= 0 || query.Size <= 0 || query.Size > MaxPageSize)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "分页参数非法");
        }

        if (query.Status is < 0 or > 4)
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章状态非法");
        }

        if (query.Cursor is { } cursor
            && (query.IsDeleted
                || query.IncludePrivate
                || query.Status.HasValue
                || cursor.Id <= 0
                || cursor.CreateTimeUtc.Kind != DateTimeKind.Utc))
        {
            return Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章 cursor 参数非法");
        }

        return Result<CorePageResult<ArticleListCoreModel>>.Success(await gateway.GetPageListAsync(query, cancellationToken));
    }

    public async Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(ArticleDetailQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Id <= 0)
        {
            return Result<ArticleDetailCoreModel?>.Failure(ErrorCode.Validation, "文章ID非法");
        }

        var data = await gateway.GetByIdAsync(query, cancellationToken);
        if (data is null)
        {
            return Result<ArticleDetailCoreModel?>.Failure(ErrorCode.NotFound, "文章不存在");
        }

        if (data.Value.Status == 2 && string.IsNullOrWhiteSpace(data.Value.Content))
        {
            return Result<ArticleDetailCoreModel?>.Failure(ErrorCode.InfraFailure, "article_body_missing");
        }

        return Result<ArticleDetailCoreModel?>.Success(data);
    }

    public async Task<Result<int>> CreateAsync(CreateArticleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleWriteRequestCoreModel article = command.Article;
        if (article.BaseRevisionId.HasValue)
        {
            return Result<int>.Failure(ErrorCode.Validation, "article_base_revision_not_allowed_on_create");
        }
        ErrorDetail? publicationValidation = ValidatePublicationRequiredFields(article);
        if (publicationValidation.HasValue)
        {
            return Result<int>.Failure(publicationValidation.Value);
        }

        ArticleStatusTransitionValidation? statusValidation = ArticleStatusTransitionPolicy.ValidateTarget(
            article.Status,
            article.ScheduledPublishAt,
            _timeProvider.GetUtcNow().UtcDateTime);
        if (statusValidation.HasValue)
        {
            return Result<int>.Failure(ToError(statusValidation.Value));
        }

        int id;
        try
        {
            id = await gateway.CreateAsync(command, cancellationToken);
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result<int>.Failure(ToError(ex.Validation));
        }
        catch (ArticleWriteValidationException ex)
        {
            return Result<int>.Failure(ToError(ex));
        }
        return id > 0
            ? Result<int>.Success(id)
            : Result<int>.Failure(ErrorCode.InfraFailure, "文章创建失败");
    }

    public async Task<Result> UpdateAsync(UpdateArticleCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleWriteRequestCoreModel article = command.Article;
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        ErrorDetail? publicationValidation = ValidatePublicationRequiredFields(article);
        if (publicationValidation.HasValue)
        {
            return Result.Failure(publicationValidation.Value);
        }

        ArticleStatusTransitionValidation? statusValidation = ArticleStatusTransitionPolicy.ValidateTarget(
            article.Status,
            article.ScheduledPublishAt,
            _timeProvider.GetUtcNow().UtcDateTime);
        if (statusValidation.HasValue)
        {
            return Result.Failure(ToError(statusValidation.Value));
        }

        if (!command.Force && !article.BaseRevisionId.HasValue)
        {
            return Result.Failure(ErrorCode.Validation, "article_base_revision_required");
        }

        if (command.Intent == ArticleUpdateIntent.Rollback)
        {
            if (command.Force || !command.Rollback.HasValue)
            {
                return Result.Failure(ErrorCode.Validation, "article_rollback_metadata_required");
            }

            ArticleRollbackMetadata rollback = command.Rollback.Value;
            if (rollback.SourceRevisionId <= 0
                || rollback.ActorAdminPrincipalId <= 0
                || string.IsNullOrWhiteSpace(rollback.Reason)
                || rollback.Reason.Length is < 8 or > 500)
            {
                return Result.Failure(ErrorCode.Validation, "article_rollback_metadata_invalid");
            }
        }
        else if (command.Rollback.HasValue)
        {
            return Result.Failure(ErrorCode.Validation, "article_rollback_metadata_unexpected");
        }

        try
        {
            return await gateway.UpdateAsync(command, cancellationToken)
                ? Result.Success()
                : Result.Failure(ErrorCode.NotFound, "文章不存在或更新失败");
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result.Failure(ToError(ex.Validation));
        }
        catch (ArticleWriteValidationException ex)
        {
            return Result.Failure(ToError(ex));
        }
        catch (ArticleRevisionConflictException ex)
        {
            return Result.Failure(ErrorDetail.Create(ErrorCode.Conflict, "article_revision_conflict", ex.ToApiDetails()));
        }
    }

    public async Task<Result> DeleteAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.DeleteAsync(command, cancellationToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或删除失败");
    }

    public async Task<Result> RestoreAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        try
        {
            return await gateway.RestoreAsync(command, cancellationToken)
                ? Result.Success()
                : Result.Failure(ErrorCode.NotFound, "文章不存在或恢复失败");
        }
        catch (ArticleStatusTransitionValidationException ex)
        {
            return Result.Failure(ToError(ex.Validation));
        }
    }

    public async Task<Result> PermanentlyDeleteArticleAsync(ArticleIdCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.Id <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        return await gateway.PermanentlyDeleteArticleAsync(command, cancellationToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "文章不存在或彻底删除失败");
    }

    public async Task<Result<int>> ClearTrashAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var count = await gateway.ClearTrashAsync(cancellationToken);
        return Result<int>.Success(count);
    }

    private static ErrorDetail ToError(ArticleStatusTransitionValidation validation)
        => ErrorDetail.Create(
            ErrorCode.Validation,
            validation.Message,
            details: validation.Code);

    private static ErrorDetail ToError(ArticleWriteValidationException exception)
        => ErrorDetail.Create(
            ErrorCode.Validation,
            exception.Message,
            details: exception.Code);

    private static ErrorDetail? ValidatePublicationRequiredFields(ArticleWriteRequestCoreModel article)
    {
        if (article.Status is not (ArticleStatusValues.Scheduled or ArticleStatusValues.Published))
        {
            return null;
        }
        if (string.IsNullOrWhiteSpace(article.Title))
        {
            return ErrorDetail.Create(ErrorCode.Validation, "标题不能为空", details: "title_invalid");
        }
        if (string.IsNullOrWhiteSpace(article.Content))
        {
            return ErrorDetail.Create(ErrorCode.Validation, "正文不能为空", details: "content_invalid");
        }
        return article.CategoryId <= 0
            ? ErrorDetail.Create(ErrorCode.Validation, "发布文章必须选择有效分类", details: "category_not_found")
            : null;
    }

    public async Task<Result<IReadOnlyList<ArticleListCoreModel>>> SearchArticlesAsync(ArticleSearchQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(query.Keyword))
        {
            return Result<IReadOnlyList<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "关键词不能为空");
        }

        return Result<IReadOnlyList<ArticleListCoreModel>>.Success(await gateway.SearchArticlesAsync(query, cancellationToken));
    }

    public async Task<Result<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Count <= 0)
        {
            return Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<PopularArticleCoreModel>>.Success(await gateway.GetHotArticlesAsync(query, cancellationToken));
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleCoreModel>>> GetFeaturedArticlesAsync(ArticleCountQuery query, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.Count <= 0)
        {
            return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Failure(ErrorCode.Validation, "数量参数非法");
        }

        return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success(await gateway.GetFeaturedArticlesAsync(query, cancellationToken));
    }

    public async ValueTask<Result> IncreaseViewCountAsync(ArticleViewCountCommand command, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (command.ArticleId <= 0 || command.Count <= 0)
        {
            return Result.Failure(ErrorCode.Validation, "文章ID非法");
        }

        await gateway.IncreaseViewCountAsync(command, cancellationToken);
        return Result.Success();
    }

    public async ValueTask<Result<IReadOnlySet<int>>> IncreaseViewCountsAsync(ArticleViewCountBatchCommand command, CancellationToken cancellationToken = default)
    {
        IReadOnlyDictionary<int, int> articleCounts = command.ArticleCounts;
        if (articleCounts is null || articleCounts.Count == 0)
        {
            return Result<IReadOnlySet<int>>.Success(new HashSet<int>());
        }

        Dictionary<int, int> normalized = new(articleCounts.Count);
        foreach ((int articleId, int count) in articleCounts)
        {
            if (articleId <= 0)
            {
                return Result<IReadOnlySet<int>>.Failure(ErrorCode.Validation, "文章ID非法");
            }

            if (count < 0)
            {
                return Result<IReadOnlySet<int>>.Failure(ErrorCode.Validation, "阅读量增量非法");
            }

            if (count == 0)
            {
                continue;
            }

            normalized[articleId] = normalized.TryGetValue(articleId, out int existing)
                ? checked(existing + count)
                : count;
        }

        if (normalized.Count == 0)
        {
            return Result<IReadOnlySet<int>>.Success(new HashSet<int>());
        }

        IReadOnlySet<int> updated = await gateway.IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(normalized), cancellationToken);
        return Result<IReadOnlySet<int>>.Success(updated);
    }
}
