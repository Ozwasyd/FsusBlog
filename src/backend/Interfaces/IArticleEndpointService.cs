using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct ArticleEndpointPayload<T>(OwnedAedsFrameReadLease? CachedFrame, Result<T> Result)
{
    public bool HasCachedFrame => CachedFrame is not null;
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
        bool canReadPrivate,
        string? keyword = null,
        CancellationToken cancellationToken = default);

    Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(
        int id,
        bool canReadPrivate = false,
        CancellationToken cancellationToken = default);

    Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync(
        int id,
        CancellationToken cancellationToken = default);

    Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(
        int count,
        CancellationToken cancellationToken = default);

    Task<Result<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(
        int count,
        CancellationToken cancellationToken = default);

    Task<int> CreateAsync(ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default);

    Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default);

    Task<int> ClearTrashAsync(CancellationToken cancellationToken = default);

    Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default);

    Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default);

    Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default);
}
