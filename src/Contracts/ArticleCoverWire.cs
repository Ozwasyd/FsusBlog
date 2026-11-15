namespace FsusBlog.V2.Contracts;

public sealed record ArticleCoverCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, Guid AssetId)
{
    public const int FrameBytes = Aeds.HeaderSize + 44;
}

public static partial class Wire
{
    public static byte[] EncodeArticleCoverCommand(ArticleCoverCommand value)
    {
        ValidateCover(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        writer.Uuid(value.AssetId);
        return Aeds.Encode(FrameType.ArticleCoverCommand, writer.Written);
    }

    public static ArticleCoverCommand DecodeArticleCoverCommand(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.ArticleCoverCommand));
        var value = new ArticleCoverCommand(reader.I32(), reader.I64(), reader.Uuid(), reader.Uuid());
        reader.Finish();
        ValidateCover(value);
        return value;
    }

    private static void ValidateCover(ArticleCoverCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty)
            throw new ProtocolException("Invalid saved article cover command.");
    }
}
