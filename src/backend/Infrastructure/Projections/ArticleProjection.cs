using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class ArticleProjection
{
    private const int MaxListTags = 2;

    public static ArticleListItemResponse ToResponse(ArticleListItemReadModel item)
    {
        return new ArticleListItemResponse
        {
            Id = item.Id,
            Title = item.Title,
            Summary = string.IsNullOrWhiteSpace(item.Snippet) ? item.Summary : item.Snippet,
            CoverImageUrl = item.CoverImageUrl,
            Views = item.Views,
            CreateTime = item.CreateTime,
            Category = new ArticleCategoryView(item.CategoryId, item.CategoryName),
            Tags = item.Tags.Take(MaxListTags).Select(ToTagResponse).ToList(),
            IsDeleted = item.IsDeleted,
            Status = (int)item.Status,
            ScheduledPublishAt = item.ScheduledPublishAt,
            PublishedAt = item.PublishedAt
        };
    }

    public static ArticleDetailResponse ToResponse(ArticleDetailReadModel item)
    {
        string resolvedContent = ResolveDetailContent(item);

        return new ArticleDetailResponse
        {
            Id = item.Id,
            Title = item.Title,
            Content = resolvedContent,
            Summary = item.Summary,
            CoverImageUrl = item.CoverImageUrl,
            Views = item.Views,
            CreateTime = item.CreateTime,
            Category = new ArticleCategoryView(item.CategoryId, item.CategoryName),
            Tags = item.Tags.Select(ToTagResponse).ToList(),
            IsDeleted = item.IsDeleted,
            Status = (int)item.Status,
            ScheduledPublishAt = item.ScheduledPublishAt,
            PublishedAt = item.PublishedAt
        };
    }

    public static FeaturedArticleSummaryDto ToFeaturedDto(ArticleListItemReadModel item)
    {
        return new FeaturedArticleSummaryDto(
            item.Id,
            item.Title,
            item.CoverImageUrl ?? string.Empty,
            item.Views,
            item.CreateTime,
            new ArticleCategoryView(item.CategoryId, item.CategoryName)
        );
    }

    public static TagDto ToTagResponse(TagReadModel tag) => new(tag.Id, tag.Name);

    public static CategoryListItemResponse ToCategoryResponse(int id, string name, int articleCount)
        => new() { Id = id, Name = name, ArticleCount = articleCount };

    public static PageResponse<ArticleListItemResponse> ToResponsePage(ArticleListPageReadModel page)
        => new() { Items = page.Items.Select(ToResponse).ToList(), Total = page.Total };

    public static ArticleListCoreModel ToCoreListModel(ArticleListItemReadModel item)
    {
        var pod = PodProjector.ProjectArticleList(
            item.Id,
            item.Views,
            item.CreateTime,
            item.CategoryId,
            item.CategoryName,
            item.Title,
            string.IsNullOrWhiteSpace(item.Snippet) ? item.Summary : item.Snippet,
            item.IsDeleted,
            out _);

        return new ArticleListCoreModel(
            pod,
            item.Id,
            item.Title,
            string.IsNullOrWhiteSpace(item.Snippet) ? item.Summary : item.Snippet,
            item.CoverImageUrl,
            string.IsNullOrWhiteSpace(item.Snippet) ? item.Summary : item.Snippet,
            item.Views,
            item.CreateTime,
            new ArticleCategoryCoreModel(item.CategoryId, item.CategoryName),
            item.Tags.Take(MaxListTags).Select(t => new TagCoreModel(t.Id, t.Name)).ToList(),
            item.IsDeleted,
            (int)item.Status,
            item.ScheduledPublishAt,
            item.PublishedAt);
    }

    public static ArticleDetailCoreModel ToCoreDetailModel(ArticleDetailReadModel item)
    {
        string resolvedContent = ResolveDetailContent(item);

        var pod = PodProjector.ProjectArticleDetail(
            item.Id,
            item.Views,
            item.CreateTime,
            item.CategoryId,
            item.CategoryName,
            item.Title,
            resolvedContent,
            item.Summary,
            out _);

        return new ArticleDetailCoreModel(
            pod,
            item.Id,
            item.Title,
            resolvedContent,
            item.Summary,
            item.CoverImageUrl,
            item.Views,
            item.WordCount,
            item.EstimatedReadingMinutes,
            item.ShowReadingNotice,
            item.CreateTime,
            new ArticleCategoryCoreModel(item.CategoryId, item.CategoryName),
            item.Tags.Select(t => new TagCoreModel(t.Id, t.Name)).ToList(),
            item.CategoryId,
            item.IsDeleted,
            (int)item.Status,
            item.ScheduledPublishAt,
            item.PublishedAt);
    }

    public static string ResolveDetailContent(ArticleDetailReadModel item)
    {
        if (!string.IsNullOrWhiteSpace(item.Content))
        {
            return item.Content;
        }

        return item.Summary?.Trim() ?? string.Empty;
    }
}
