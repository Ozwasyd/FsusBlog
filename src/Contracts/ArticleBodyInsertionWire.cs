namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(ArticleBodyInsertionCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.Offset < 0 || value.Length <= 0 || value.Length > value.Body.Length || value.Offset > value.Body.Length - value.Length)
            throw new ProtocolException("Invalid article insertion command coordinates.");
    }

    internal static void Validate(DraftRevisionBodyInsertion value)
    {
        if (value.Id <= 0 || value.SourceRevision <= 0 || value.SourceRevision >= value.Revision)
            throw new ProtocolException("Invalid saved body insertion coordinates.");
        if (value.Available)
        {
            if (value.SourceRevision == value.Revision - 1 && value.Offset >= 0 && value.Offset <= value.SourceBody.Length &&
                value.Length > 0 && value.Length == value.Body.Length - value.SourceBody.Length &&
                IsInsertionDigest(value.SourceDigest) && IsInsertionDigest(value.Digest)) return;
        }
        else if (value.Offset == 0 && value.Length == 0 && value.SourceDigest.Length == 0 && value.Digest.Length == 0 &&
            value.SourceBody.Length == 0 && value.Body.Length == 0) return;
        throw new ProtocolException("Invalid saved body insertion payload.");
    }

    private static bool IsInsertionDigest(string digest) =>
        digest.Length == WireLimits.ArticleBodyInsertionDigestBytes &&
        digest.All(value => value is >= '0' and <= '9' or >= 'a' and <= 'f');
}
