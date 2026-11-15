namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminArticleTrashRestoreIntent value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision is <= 0 or long.MaxValue || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid administrator trash restore intent.");
    }

    private static void Validate(AdminArticleTrashRestoreReceipt value)
    {
        if (value.ArticleId <= 0 || value.Revision < 2)
            throw new ProtocolException("Invalid administrator trash restore receipt.");
    }
}
