namespace FsusBlog.V2.Contracts;

public sealed record RelatedItem(int Id, DateTimeOffset CreatedAt, string Title, string? Summary, string Reason);
public sealed record RelatedReading(IReadOnlyList<RelatedItem> Related, RelatedItem? Previous, RelatedItem? Next);

public static class RelatedReadingWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] Encode(RelatedReading reading)
    {
        if (reading.Related.Count > WireLimits.RelatedReadingMaxItems)
            throw new ProtocolException("Too many related articles");
        var items = reading.Related.Concat(new[] { reading.Previous, reading.Next }.OfType<RelatedItem>()).ToArray();
        var fields = items.Select(EncodeText).ToArray();
        var blobAt = RelatedReadingHeaderSize + items.Length * RelatedReadingItemSize + sizeof(int);
        var blobLength = fields.Sum(row => row.Title.Length + row.Summary.Length + row.Reason.Length);
        var payload = new byte[blobAt + blobLength];
        BinaryPrimitives.WriteInt32LittleEndian(payload, reading.Related.Count);
        payload[RelatedReadingPreviousOffset] = reading.Previous is null ? (byte)0 : (byte)1;
        payload[RelatedReadingNextOffset] = reading.Next is null ? (byte)0 : (byte)1;
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(blobAt - sizeof(int)), blobLength);

        var offset = 0;
        for (var index = 0; index < items.Length; index++)
        {
            var item = items[index];
            var row = payload.AsSpan(RelatedReadingHeaderSize + index * RelatedReadingItemSize, RelatedReadingItemSize);
            var blob = payload.AsSpan(blobAt, blobLength);
            BinaryPrimitives.WriteInt32LittleEndian(row, item.Id);
            BinaryPrimitives.WriteInt64LittleEndian(row[RelatedReadingItemCreatedAtOffset..], item.CreatedAt.ToUnixTimeMilliseconds());
            row[RelatedReadingItemHasSummaryOffset] = item.Summary is null ? (byte)0 : (byte)1;
            WriteSlice(row[RelatedReadingItemTitleOffset..], blob, fields[index].Title, ref offset);
            if (item.Summary is not null)
                WriteSlice(row[RelatedReadingItemSummaryOffset..], blob, fields[index].Summary, ref offset);
            WriteSlice(row[RelatedReadingItemReasonOffset..], blob, fields[index].Reason, ref offset);
        }

        return Aeds.Encode(FrameType.ArticleRelatedReading, payload);
    }

    private static (byte[] Title, byte[] Summary, byte[] Reason) EncodeText(RelatedItem item)
    {
        if (item.Id <= 0 || item.Title.Length == 0 || item.Reason.Length == 0)
            throw new ProtocolException("Invalid related article");
        return (Text(item.Title, WireLimits.TitleBytes), Text(item.Summary ?? string.Empty, WireLimits.RelatedReadingMaxTextBytes),
            Text(item.Reason, WireLimits.RelatedReadingMaxTextBytes));
    }

    private static byte[] Text(string text, int limit)
    {
        if (Utf8.GetByteCount(text) > limit)
            throw new ProtocolException("Related article text exceeds its byte limit");
        return Utf8.GetBytes(text);
    }

    private static void WriteSlice(Span<byte> slot, Span<byte> blob, ReadOnlySpan<byte> value, ref int offset)
    {
        BinaryPrimitives.WriteInt32LittleEndian(slot, offset);
        BinaryPrimitives.WriteInt32LittleEndian(slot[sizeof(int)..], value.Length);
        value.CopyTo(blob[offset..]);
        offset += value.Length;
    }
}
