namespace FsusBlog.V2.Contracts;

public sealed record ArticleMediaCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId, bool Attach)
{
    public const int FrameBytes = Aeds.HeaderSize + 45;
}

public sealed record ArticleMediaEntry(Guid Id, string Ticket);

public static partial class Wire
{
    public static byte[] EncodeArticleMediaCommand(ArticleMediaCommand value)
    {
        ValidateMedia(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        writer.Uuid(value.AssetId);
        writer.Bool(value.Attach);
        return Aeds.Encode(FrameType.ArticleMediaCommand, writer.Written);
    }

    public static ArticleMediaCommand DecodeArticleMediaCommand(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.ArticleMediaCommand));
        var command = new ArticleMediaCommand(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid(), reader.Bool());
        reader.Finish();
        ValidateMedia(command);
        return command;
    }

    public static byte[] EncodeArticleMedia(int article, long revision, IReadOnlyList<ArticleMediaEntry> entries)
    {
        if (article <= 0 || revision <= 0 || entries.Count > 32) throw new ProtocolException("Invalid private article attachments.");
        var writer = new Writer();
        writer.I32(article);
        writer.I64(revision);
        writer.I32(entries.Count);
        foreach (var entry in entries)
        {
            if (entry.Id == Guid.Empty || entry.Ticket.Length != 91 || entry.Ticket.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not '-' and not '_'))
                throw new ProtocolException("Invalid private article attachment coordinate.");
            writer.Uuid(entry.Id);
            writer.Text(entry.Ticket, 91);
        }
        return Aeds.Encode(FrameType.ArticleMedia, writer.Written);
    }

    private static void ValidateMedia(ArticleMediaCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty || value.AssetId == Guid.Empty)
            throw new ProtocolException("Invalid private article attachment command.");
    }
}
