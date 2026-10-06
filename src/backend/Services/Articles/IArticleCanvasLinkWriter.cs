using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Articles;

/// <summary>Canvas conversion is an article mutation, never a canvas operation.</summary>
public interface IArticleCanvasLinkWriter
{
    Task<ArticleCanvasLinkReceipt> ConvertAsync(
        AuthoringCanvasOwner owner,
        ArticleCanvasLinkRequest request,
        CancellationToken cancellationToken = default);

    Task<ArticleCanvasLinkHistoryResponse> ReadHistoryAsync(
        AuthoringCanvasOwner owner,
        int articleId,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleCanvasLinkOutcomeUnknownException(Guid requestId, Exception innerException)
    : Exception("article_canvas_link_outcome_unknown", innerException)
{
    public Guid RequestId { get; } = requestId;
}
