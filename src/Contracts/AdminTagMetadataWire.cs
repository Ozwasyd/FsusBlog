namespace FsusBlog.V2.Contracts;

public sealed record AdminTagMetadataCommand(int Id, long ExpectedRevision, Guid RequestId, string Name, string Description);
public sealed record AdminTagMetadata(int Id, long Revision, string Name, string Description, bool Changed);

public static partial class Wire
{
    public static byte[] EncodeAdminTagMetadataCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminTagMetadataCommand);
    public static byte[] EncodeAdminTagCreateCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminTagCreateCommand);
    public static byte[] EncodeAdminCategoryMetadataCommand(AdminTagMetadataCommand value) => EncodeTaxonomyCommand(value, FrameType.AdminCategoryMetadataCommand);
    public static AdminTagMetadataCommand DecodeAdminTagMetadataCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminTagMetadataCommand);
    public static AdminTagMetadataCommand DecodeAdminTagCreateCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminTagCreateCommand);
    public static AdminTagMetadataCommand DecodeAdminCategoryMetadataCommand(ReadOnlySpan<byte> frame) => DecodeTaxonomyCommand(frame, FrameType.AdminCategoryMetadataCommand);
    public static byte[] EncodeAdminTagMetadata(AdminTagMetadata value) => EncodeTaxonomyMetadata(value, FrameType.AdminTagMetadata);
    public static byte[] EncodeAdminCategoryMetadata(AdminTagMetadata value) => EncodeTaxonomyMetadata(value, FrameType.AdminCategoryMetadata);
    public static AdminTagMetadata DecodeAdminTagMetadata(ReadOnlySpan<byte> frame) => DecodeTaxonomyMetadata(frame, FrameType.AdminTagMetadata);
    public static AdminTagMetadata DecodeAdminCategoryMetadata(ReadOnlySpan<byte> frame) => DecodeTaxonomyMetadata(frame, FrameType.AdminCategoryMetadata);

    private static byte[] EncodeTaxonomyCommand(AdminTagMetadataCommand value, FrameType type)
    {
        ValidateTaxonomyCommand(value, type);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.RequestId);
        writer.Text(value.Name, type == FrameType.AdminCategoryMetadataCommand ? WireLimits.AdminCategoryNameBytes : WireLimits.AdminTagNameBytes);
        writer.Text(value.Description, WireLimits.TaxonomyDescriptionBytes);
        return Aeds.Encode(type, writer.Written);
    }

    private static AdminTagMetadataCommand DecodeTaxonomyCommand(ReadOnlySpan<byte> frame, FrameType type)
    {
        var reader = new Reader(Aeds.Decode(frame, type));
        var value = new AdminTagMetadataCommand(reader.I32(), reader.I64(), reader.Uuid(),
            reader.Text(type == FrameType.AdminCategoryMetadataCommand ? WireLimits.AdminCategoryNameBytes : WireLimits.AdminTagNameBytes), reader.Text(WireLimits.TaxonomyDescriptionBytes));
        reader.Finish();
        ValidateTaxonomyCommand(value, type);
        return value;
    }

    private static byte[] EncodeTaxonomyMetadata(AdminTagMetadata value, FrameType type)
    {
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.Revision);
        writer.Text(value.Name, WireLimits.TaxonomyNameBytes);
        writer.Text(value.Description, WireLimits.TaxonomyDescriptionBytes);
        writer.Bool(value.Changed);
        return Aeds.Encode(type, writer.Written);
    }

    private static AdminTagMetadata DecodeTaxonomyMetadata(ReadOnlySpan<byte> frame, FrameType type)
    {
        var reader = new Reader(Aeds.Decode(frame, type));
        var value = new AdminTagMetadata(reader.I32(), reader.I64(), reader.Text(WireLimits.TaxonomyNameBytes),
            reader.Text(WireLimits.TaxonomyDescriptionBytes), reader.Bool());
        reader.Finish();
        if (value.Id <= 0 || value.Revision < 0 || value.Name.Length == 0)
            throw InvalidTaxonomyMetadata(type == FrameType.AdminCategoryMetadata);
        return value;
    }

    private static void ValidateTaxonomyCommand(AdminTagMetadataCommand value, FrameType type)
    {
        var valid = type switch
        {
            FrameType.AdminTagCreateCommand => value.Id == 0 && value.ExpectedRevision == 0,
            FrameType.AdminTagMetadataCommand => value.Id > 0 && value.ExpectedRevision >= 0,
            FrameType.AdminCategoryMetadataCommand => value.Id >= 0 && value.ExpectedRevision >= 0 &&
                (value.Id > 0 || value.ExpectedRevision == 0),
            _ => false,
        };
        if (!valid || value.RequestId == Guid.Empty) throw InvalidTaxonomyMetadata(type == FrameType.AdminCategoryMetadataCommand);
    }

    private static ProtocolException InvalidTaxonomyMetadata(bool category) =>
        new(category ? "Invalid administrator category metadata." : "Invalid administrator tag metadata.");
}
