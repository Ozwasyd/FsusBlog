namespace FsusBlog.V2.Contracts;

public sealed record PrivateMediaItem(Guid Id, string Name, int Format, int Length, int Width, int Height, DateTimeOffset CreatedAt);

public static partial class Wire
{
    public static byte[] EncodePrivateMediaUpload(Guid id, int length, int partSize, long expiresAt,
        bool reserved, Guid? asset, IReadOnlyList<int> received)
    {
        if (id == Guid.Empty || length is < 1 or > WireLimits.PrivateMediaBytes || partSize is < 65536 or > 2097152 ||
            expiresAt <= 0 || asset == Guid.Empty || asset.HasValue && (!reserved || received.Count != 0) ||
            received.Count > 320)
            throw new ProtocolException("Invalid private upload state.");
        int total = (length + partSize - 1) / partSize;
        var previous = -1;
        foreach (var part in received)
        {
            if (part <= previous || part >= total) throw new ProtocolException("Invalid private upload part list.");
            previous = part;
        }
        var writer = new Writer();
        writer.Uuid(id);
        writer.I32(length);
        writer.I32(partSize);
        writer.I64(expiresAt);
        writer.Bool(reserved);
        writer.Bool(asset.HasValue);
        if (asset is Guid coordinate) writer.Uuid(coordinate);
        writer.I32s(received, 320);
        return Aeds.Encode(FrameType.PrivateMediaUploadState, writer.Written);
    }

    public static byte[] EncodePrivateMedia(IReadOnlyList<PrivateMediaItem> items, bool hasMore = false)
    {
        if (items.Count > 50 || items.Count == 0 && hasMore)
            throw new ProtocolException("Invalid private media page.");

        var writer = new Writer();
        writer.I32(WireLayouts.PrivateMediaVersion);
        writer.Bool(hasMore);
        writer.I32(items.Count);
        foreach (var item in items)
        {
            if (item.Format is not (1 or 2 or 3) || item.Length is < 1 or > WireLimits.PrivateMediaBytes ||
                item.Width is < 1 or > 8192 || item.Height is < 1 or > 8192 || item.Id == Guid.Empty ||
                item.CreatedAt.Offset != TimeSpan.Zero || item.Name.Length == 0)
                throw new ProtocolException("Invalid private media record.");
            writer.Uuid(item.Id);
            writer.I32(item.Format);
            writer.I32(item.Length);
            writer.I32(item.Width);
            writer.I32(item.Height);
            writer.I64(item.CreatedAt.UtcTicks);
            writer.Text(item.Name, 255);
        }
        return Aeds.Encode(FrameType.PrivateMediaItems, writer.Written);
    }
}
