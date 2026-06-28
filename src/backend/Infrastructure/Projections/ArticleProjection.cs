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
            Tags = ToListTagResponses(item.Tags),
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
            Tags = ToDetailTagResponses(item.Tags),
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
    {
        var items = new List<ArticleListItemResponse>(page.Items.Count);
        for (int i = 0; i < page.Items.Count; i++)
        {
            items.Add(ToResponse(page.Items[i]));
        }

        return new PageResponse<ArticleListItemResponse>
        {
            Items = items,
            Total = page.Total,
            NextCursor = page.NextCursor,
            HasMore = page.HasMore
        };
    }

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
            ToListCoreTags(item.Tags),
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
            ToDetailCoreTags(item.Tags),
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

    private static List<TagDto> ToListTagResponses(IReadOnlyList<TagReadModel> tags)
    {
        int count = Math.Min(tags.Count, MaxListTags);
        var result = new List<TagDto>(count);
        for (int i = 0; i < count; i++)
        {
            result.Add(ToTagResponse(tags[i]));
        }

        return result;
    }

    private static List<TagDto> ToDetailTagResponses(IReadOnlyList<TagReadModel> tags)
    {
        var result = new List<TagDto>(tags.Count);
        for (int i = 0; i < tags.Count; i++)
        {
            result.Add(ToTagResponse(tags[i]));
        }

        return result;
    }

    private static IReadOnlyList<TagCoreModel> ToListCoreTags(IReadOnlyList<TagReadModel> tags)
    {
        int count = Math.Min(tags.Count, MaxListTags);
        if (count == 0)
        {
            return Array.Empty<TagCoreModel>();
        }

        var result = new TagCoreModel[count];
        for (int i = 0; i < count; i++)
        {
            TagReadModel tag = tags[i];
            result[i] = new TagCoreModel(tag.Id, tag.Name);
        }

        return result;
    }

    private static IReadOnlyList<TagCoreModel> ToDetailCoreTags(IReadOnlyList<TagReadModel> tags)
    {
        if (tags.Count == 0)
        {
            return Array.Empty<TagCoreModel>();
        }

        var result = new TagCoreModel[tags.Count];
        for (int i = 0; i < tags.Count; i++)
        {
            TagReadModel tag = tags[i];
            result[i] = new TagCoreModel(tag.Id, tag.Name);
        }

        return result;
    }
}
