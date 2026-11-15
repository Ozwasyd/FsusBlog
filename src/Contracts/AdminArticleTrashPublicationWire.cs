namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminArticleTrashPublicationPreview preview)
    {
        ValidateTrashPublication(preview.ArticleId, preview.ExpectedRevision, preview.SourceRevision, preview.SourcePublicationId);
        if (string.IsNullOrWhiteSpace(preview.Title)) throw new ProtocolException("Invalid former publication title.");
    }

    private static void Validate(AdminArticleTrashPublicationIntent intent)
    {
        ValidateTrashPublication(intent.ArticleId, intent.ExpectedRevision, intent.SourceRevision, intent.SourcePublicationId);
        if (intent.IdempotencyKey == Guid.Empty || intent.Reason.Length is < 8 or > 500 ||
            intent.Reason != intent.Reason.Trim() || intent.Reason.Any(char.IsControl))
            throw new ProtocolException("Invalid trash republication approval.");
    }

    private static void Validate(AdminArticleTrashPublicationReceipt receipt)
    {
        if (receipt.Revision < 3 || receipt.PublicationId <= 0 || receipt.PublicationId == receipt.SourcePublicationId)
            throw new ProtocolException("Invalid recovered publication.");
        ValidateTrashPublication(receipt.ArticleId, receipt.Revision - 1, receipt.SourceRevision, receipt.SourcePublicationId);
    }

    private static void ValidateTrashPublication(int article, long expected, long source, long publication)
    {
        if (article <= 0 || source <= 0 || source >= expected || expected == long.MaxValue || publication <= 0)
            throw new ProtocolException("Invalid former publication coordinates.");
    }
}
