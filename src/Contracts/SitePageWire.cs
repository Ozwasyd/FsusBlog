using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public static class SitePageWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] Encode(string slug, string markdown)
    {
        if (slug.Length == 0 || slug.Length >= WireLayouts.PageContentSlugBytes ||
            !slug.All(character => character is >= 'a' and <= 'z') ||
            markdown.Length > WireLimits.PageContentChars || markdown.Contains('\0'))
            throw new ProtocolException("Invalid site page content");

        var byteCount = Utf8.GetByteCount(markdown);
        if (byteCount > WireLimits.PageContentBytes)
            throw new ProtocolException("Site page exceeds its byte limit");

        var payload = new byte[WireLayouts.PageContentBlobOffset + byteCount];
        var slugBytes = WireLayouts.PageContentSlugBytes;
        Utf8.GetBytes(slug, payload.AsSpan(0, slugBytes));
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(slugBytes + 4), byteCount);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(slugBytes + 8), byteCount);
        Utf8.GetBytes(markdown, payload.AsSpan(WireLayouts.PageContentBlobOffset));
        return Aeds.Encode(FrameType.PageContent, payload);
    }
}
