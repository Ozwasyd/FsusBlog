namespace FsusBlog.V2.Contracts;

public sealed record PropertyTextHitRequest(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid DefinitionId, long DefinitionRevision, byte[] SourceDigest);

public static partial class Wire
{
    public static byte[] EncodePropertyTextHitRequest(PropertyTextHitRequest value)
    {
        ValidatePropertyTextHitRequest(value);
        var writer = new Writer();
        writer.I32(value.ArticleId);
        writer.I64(value.ArticleRevision);
        writer.I64(value.SchemaRevision);
        writer.I64(value.ValueRevision);
        writer.Uuid(value.DefinitionId);
        writer.I64(value.DefinitionRevision);
        writer.FixedBytes(value.SourceDigest);
        return Aeds.Encode(FrameType.PropertyTextHitRequest, writer.Written);
    }

    public static PropertyTextHitRequest DecodePropertyTextHitRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length != WireLimits.PropertyTextHitRequestFrameBytes) throw InvalidPropertyTextHitRequest();
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyTextHitRequest));
        var value = new PropertyTextHitRequest(reader.I32(), reader.I64(), reader.I64(), reader.I64(), reader.Uuid(),
            reader.I64(), reader.FixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes).ToArray());
        reader.Finish();
        ValidatePropertyTextHitRequest(value);
        return value;
    }

    private static void ValidatePropertyTextHitRequest(PropertyTextHitRequest value)
    {
        if (value.ArticleId <= 0 || value.ArticleRevision <= 0 || value.SchemaRevision <= 0 || value.ValueRevision < 0 ||
            value.DefinitionId == Guid.Empty || value.DefinitionRevision <= 0 || value.DefinitionRevision > value.SchemaRevision ||
            value.SourceDigest.Length != WireLimits.AuthorTextSearchSourceDigestBytes)
            throw InvalidPropertyTextHitRequest();
    }

    private static ProtocolException InvalidPropertyTextHitRequest() => new("Invalid saved text property match request.");
}
