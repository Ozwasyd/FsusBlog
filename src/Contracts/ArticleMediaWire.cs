namespace FsusBlog.V2.Contracts;

public sealed record ArticleMediaCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId, bool Attach)
{
    public const int FrameBytes = Aeds.HeaderSize + 45;
}

public sealed record ArticleMediaEntry(Guid Id, string Ticket);

public static partial class Wire
{
    public static byte[] EncodeArticleMediaCommand(ArticleMediaCommand value) =>
        EncodeRecord(FrameType.ArticleMediaCommand, value, ValidateMedia, static (writer, record) =>
        {
            writer.I32(record.Id);
            writer.I64(record.ExpectedRevision);
            writer.Uuid(record.IdempotencyKey);
            writer.Uuid(record.AssetId);
            writer.Bool(record.Attach);
        });

    public static ArticleMediaCommand DecodeArticleMediaCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<ArticleMediaCommand>(FrameType.ArticleMediaCommand, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid(), reader.Bool()), ValidateMedia);

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
