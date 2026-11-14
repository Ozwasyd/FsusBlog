namespace FsusBlog.V2.Contracts;

public sealed record PrivateMediaItem(Guid Id, string Name, int Format, int Length, int Width, int Height, DateTimeOffset CreatedAt);

public static partial class Wire
{
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
            if (item.Format is not (1 or 2) || item.Length is < 1 or > WireLimits.PrivateMediaBytes ||
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
