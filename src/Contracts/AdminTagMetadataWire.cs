namespace FsusBlog.V2.Contracts;

public sealed record AdminTagMetadataCommand(int Id, long ExpectedRevision, Guid RequestId, string Name, string Description);
public sealed record AdminTagMetadata(int Id, long Revision, string Name, string Description, bool Changed);

public static partial class Wire
{
    public static byte[] EncodeAdminTagMetadataCommand(AdminTagMetadataCommand value)
    {
        ValidateTagCoordinates(value.Id, value.ExpectedRevision);
        if (value.RequestId == Guid.Empty) throw InvalidTag();
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.RequestId);
        writer.Text(value.Name, WireLimits.AdminTagNameBytes);
        writer.Text(value.Description, WireLimits.TaxonomyDescriptionBytes);
        return Aeds.Encode(FrameType.AdminTagMetadataCommand, writer.Written);
    }

    public static AdminTagMetadataCommand DecodeAdminTagMetadataCommand(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminTagMetadataCommand));
        var value = new AdminTagMetadataCommand(reader.I32(), reader.I64(), reader.Uuid(), reader.Text(WireLimits.AdminTagNameBytes),
            reader.Text(WireLimits.TaxonomyDescriptionBytes));
        reader.Finish();
        ValidateTagCoordinates(value.Id, value.ExpectedRevision);
        if (value.RequestId == Guid.Empty) throw InvalidTag();
        return value;
    }

    public static byte[] EncodeAdminTagMetadata(AdminTagMetadata value)
    {
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.Revision);
        writer.Text(value.Name, WireLimits.TaxonomyNameBytes);
        writer.Text(value.Description, WireLimits.TaxonomyDescriptionBytes);
        writer.Bool(value.Changed);
        return Aeds.Encode(FrameType.AdminTagMetadata, writer.Written);
    }

    public static AdminTagMetadata DecodeAdminTagMetadata(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminTagMetadata));
        var value = new AdminTagMetadata(reader.I32(), reader.I64(), reader.Text(WireLimits.TaxonomyNameBytes),
            reader.Text(WireLimits.TaxonomyDescriptionBytes), reader.Bool());
        reader.Finish();
        ValidateTagCoordinates(value.Id, value.Revision);
        return value.Name.Length == 0 ? throw InvalidTag() : value;
    }

    private static void ValidateTagCoordinates(int id, long revision)
    {
        if (id <= 0 || revision < 0) throw InvalidTag();
    }

    private static ProtocolException InvalidTag() => new("Invalid administrator tag metadata.");
}
