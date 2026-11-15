namespace FsusBlog.V2.Contracts;

public sealed record AuthorRecentOpenRow(int ArticleId, long ArticleRevision, long Sequence, long OpenedAtUnixMs, string Title);
public sealed record AuthorRecentOpenPage(long Revision, string NextCursor, IReadOnlyList<AuthorRecentOpenRow> Items);

public static partial class Wire
{
    internal static void Validate(AuthorRecentOpenCommand value)
    {
        if (value.SchemaVersion != 1 || value.ExpectedRevision is < 0 or long.MaxValue || value.RequestId == Guid.Empty ||
            value.ArticleId <= 0 || value.ArticleRevision <= 0)
            throw new ProtocolException("Invalid author recent open command.");
    }

    internal static void Validate(AuthorRecentOpenReceipt value)
    {
        if (value.SchemaVersion != 1 || value.Revision <= 0 || value.RequestId == Guid.Empty || value.ArticleId <= 0 ||
            value.ArticleRevision <= 0 || value.OpenedAtUnixMs <= 0)
            throw new ProtocolException("Invalid author recent open receipt.");
    }

    public static byte[] EncodeAuthorRecentOpenPage(AuthorRecentOpenPage value)
    {
        var writer = new Writer();
        writer.I32(1);
        writer.I64(value.Revision);
        writer.Text(value.NextCursor, WireLimits.AuthorRecentOpenCursorChars);
        writer.I32(value.Items.Count);
        foreach (var item in value.Items)
        {
            writer.I32(item.ArticleId);
            writer.I64(item.ArticleRevision);
            writer.I64(item.Sequence);
            writer.I64(item.OpenedAtUnixMs);
            writer.Text(item.Title, WireLimits.TitleBytes);
        }
        return Aeds.Encode(FrameType.AuthorRecentOpenPage, writer.Written);
    }
}
