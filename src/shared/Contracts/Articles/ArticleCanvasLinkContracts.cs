using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Contracts.Articles;

public enum ArticleCanvasLinkMode
{
    Apply = 0,
    Undo = 1,
    Redo = 2
}

public sealed record ArticleCanvasLinkRequest(
    Guid RequestId,
    int SourceArticleId,
    long ExpectedArticleRevision,
    ArticleCanvasLinkMode Mode,
    Guid TargetJournalId,
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    Guid EdgeId,
    int TargetArticleId,
    long ExpectedTargetRevision);

public sealed record ArticleCanvasLinkReceipt(
    Guid RequestId,
    Guid JournalId,
    Guid ParentJournalId,
    long OwnerAdminPrincipalId,
    string SiteScope,
    int SourceArticleId,
    long PreviousArticleRevision,
    long ArticleRevision,
    long OriginalBeforeRevision,
    long OriginalAfterRevision,
    ArticleCanvasLinkMode Mode,
    Guid TargetJournalId,
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    Guid EdgeId,
    int TargetArticleId,
    long TargetRevision,
    int UndoDepth,
    int RedoDepth,
    string RequestDigest,
    string ReceiptDigest,
    bool IdempotencyReplay);

public sealed record ArticleCanvasLinkHistoryResponse(
    int SourceArticleId,
    long ArticleRevision,
    long HistoryArticleRevision,
    Guid LastJournalId,
    IReadOnlyList<ArticleCanvasLinkReceipt> UndoEntries,
    IReadOnlyList<ArticleCanvasLinkReceipt> RedoEntries,
    string HistoryDigest);

/// <summary>
/// Closed conversion identities. Digests bind records; database ownership and immutable article
/// revisions supply authority. These unkeyed digests are not authentication codes.
/// </summary>
public static class ArticleCanvasLinkContract
{
    public const int SchemaVersion = 1;
    public const int MaxHistoryDepth = 100;
    public const int MaxPayloadBytes = 131072;

    public static void Validate(ArticleCanvasLinkRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.RequestId == Guid.Empty || request.SourceArticleId <= 0
            || request.ExpectedArticleRevision <= 0 || !Enum.IsDefined(request.Mode))
        {
            throw new ArgumentException("article_canvas_link_request_invalid");
        }
        if (request.Mode == ArticleCanvasLinkMode.Apply)
        {
            if (request.TargetJournalId != Guid.Empty || request.CanvasId == Guid.Empty
                || request.CanvasRevision <= 0 || !IsDigest(request.CanvasContentDigest)
                || request.EdgeId == Guid.Empty || request.TargetArticleId <= 0
                || request.ExpectedTargetRevision <= 0)
            {
                throw new ArgumentException("article_canvas_link_apply_invalid");
            }
        }
        else if (request.TargetJournalId == Guid.Empty || request.CanvasId != Guid.Empty
            || request.CanvasRevision != 0 || request.CanvasContentDigest.Length != 0
            || request.EdgeId != Guid.Empty || request.TargetArticleId != 0
            || request.ExpectedTargetRevision != 0)
        {
            throw new ArgumentException("article_canvas_link_history_request_invalid");
        }
    }

    public static string RequestDigest(ArticleCanvasLinkRequest request)
    {
        Validate(request);
        return Digest(SchemaVersion, request.RequestId, request.SourceArticleId,
            request.ExpectedArticleRevision, (int)request.Mode, request.TargetJournalId,
            request.CanvasId, request.CanvasRevision, request.CanvasContentDigest, request.EdgeId,
            request.TargetArticleId, request.ExpectedTargetRevision);
    }

    public static string ReceiptDigest(ArticleCanvasLinkReceipt receipt)
        => Digest(SchemaVersion, receipt.RequestId, receipt.JournalId, receipt.ParentJournalId,
            receipt.OwnerAdminPrincipalId, receipt.SiteScope, receipt.SourceArticleId,
            receipt.PreviousArticleRevision, receipt.ArticleRevision, receipt.OriginalBeforeRevision,
            receipt.OriginalAfterRevision, (int)receipt.Mode,
            receipt.TargetJournalId, receipt.CanvasId, receipt.CanvasRevision,
            receipt.CanvasContentDigest, receipt.EdgeId, receipt.TargetArticleId,
            receipt.TargetRevision, receipt.UndoDepth, receipt.RedoDepth, receipt.RequestDigest);

    public static string HistoryDigest(int sourceArticleId, long articleRevision, Guid lastJournalId,
        IReadOnlyList<ArticleCanvasLinkReceipt> undo, IReadOnlyList<ArticleCanvasLinkReceipt> redo)
        => Digest(SchemaVersion, sourceArticleId, articleRevision, lastJournalId,
            string.Join(',', undo.Select(static value => value.ReceiptDigest)),
            string.Join(',', redo.Select(static value => value.ReceiptDigest)));

    public static bool IsDigest(string value)
        => value.Length == 64 && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string Digest(params object[] values)
    {
        var source = new StringBuilder();
        foreach (object value in values)
        {
            string text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
            source.Append(text.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(text);
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source.ToString()))).ToLowerInvariant();
    }
}
