namespace FsusBlog.V2.Contracts;

public sealed record ArticleCoverCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId)
{
    public const int FrameBytes = Aeds.HeaderSize + 44;
}

public static partial class Wire
{
    public static byte[] EncodeArticleCoverCommand(ArticleCoverCommand value) =>
        EncodeRecord(FrameType.ArticleCoverCommand, value, ValidateCover, static (writer, record) =>
        {
            writer.I32(record.Id);
            writer.I64(record.ExpectedRevision);
            writer.Uuid(record.IdempotencyKey);
            writer.Uuid(record.AssetId);
        });

    public static ArticleCoverCommand DecodeArticleCoverCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<ArticleCoverCommand>(FrameType.ArticleCoverCommand, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid()), ValidateCover);

    private static void ValidateCover(ArticleCoverCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid saved article cover command.");
    }
}
