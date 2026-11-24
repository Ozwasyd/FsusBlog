namespace FsusBlog.V2.Contracts;

public sealed record TaxonomyName(int Id, string Name);
public sealed record TaxonomyMetadata(int Id, string Name, string? Description);
public sealed record TaxonomyListItem(int Id, string Name, int ArticleCount);

public static class TaxonomyWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeList(FrameType kind, IReadOnlyList<TaxonomyListItem> items)
    {
        if (kind is not (FrameType.CategoryList or FrameType.TagList))
            throw new ProtocolException("Invalid taxonomy frame type");

        var names = items.Select(item => NameBytes(item.Id, item.Name)).ToArray();
        var blobLength = names.Sum(name => name.Length);
        var records = checked(WireLayouts.TaxonomyHeaderBytes + blobLength);
        var payload = Allocate(checked(records + items.Count * WireLayouts.TaxonomyListRecordSize));
        WriteInt(payload, 0, items.Count);
        WriteInt(payload, 4, blobLength);
        var position = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            if (item.ArticleCount < 0)
                throw new ProtocolException("Invalid taxonomy article count");
            var record = records + i * WireLayouts.TaxonomyListRecordSize;
            WriteInt(payload, record, item.Id);
            WriteInt(payload, record + 4, item.ArticleCount);
            WriteSlice(payload, record + 8, position, names[i]);
            position += names[i].Length;
        }
        return Aeds.Encode(kind, payload);
    }

    public static byte[] EncodeMetadata(TaxonomyMetadata item)
    {
        var name = NameBytes(item.Id, item.Name);
        var description = Utf8.GetBytes(item.Description ?? string.Empty);
        if (description.Length > WireLimits.TaxonomyDescriptionBytes || item.Description?.Contains('\0') is true)
            throw new ProtocolException("Invalid taxonomy description");
        var blobLength = name.Length + description.Length;
        var record = WireLayouts.TaxonomyHeaderBytes + blobLength;
        var payload = Allocate(record + WireLayouts.TaxonomyMetadataRecordSize);
        WriteInt(payload, 0, item.Id);
        WriteInt(payload, 4, blobLength);
        WriteSlice(payload, record, 0, name);
        WriteSlice(payload, record + 8, name.Length, description);
        return Aeds.Encode(FrameType.TaxonomyExactMetadata, payload);
    }

    internal static byte[] NameBytes(int id, string name)
    {
        if (id <= 0 || name.Length == 0 || name.Contains('\0') || Utf8.GetByteCount(name) > WireLimits.TaxonomyNameBytes)
            throw new ProtocolException("Invalid taxonomy name or ID");
        return Utf8.GetBytes(name);
    }

    private static byte[] Allocate(int length)
    {
        if (length > WireLimits.MaxPayloadBytes)
            throw new ProtocolException("Taxonomy payload exceeds its byte limit");
        return new byte[length];
    }

    private static void WriteSlice(byte[] payload, int field, int offset, byte[] text)
    {
        WriteInt(payload, field, offset);
        WriteInt(payload, field + 4, text.Length);
        text.CopyTo(payload.AsSpan(WireLayouts.TaxonomyHeaderBytes + offset));
    }

    private static void WriteInt(byte[] payload, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(offset), value);
}
