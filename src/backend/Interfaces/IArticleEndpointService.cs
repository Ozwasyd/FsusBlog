using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct ArticleEndpointPayload<T>(ReadOnlyMemory<byte> CachedPayload, Result<T> Result)
{
    public bool HasCachedPayload => !CachedPayload.IsEmpty;
}

public readonly record struct ArticleDetailArtifactPayload(ReadOnlyMemory<byte> PreencodedFrame, bool BackfillQueued)
{
    public bool HasPreencodedFrame => !PreencodedFrame.IsEmpty;
}

public interface IArticleEndpointService
{
    Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        bool canReadDeleted,
        int? status,
        bool canReadPrivate);

    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool canReadPrivate = false);

    Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync(int id);

    Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count);

    Task<Result<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(int count);

    Task<int> CreateAsync(ArticleWriteRequestCoreModel request);

    Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel request);

    Task<int> ClearTrashAsync();

    Task<bool> DeleteAsync(int id);

    Task<bool> RestoreAsync(int id);

    Task<bool> PermanentlyDeleteArticleAsync(int id);
}
