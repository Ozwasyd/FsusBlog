using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public static class SitePageWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    public const int MaxUpdateFrameBytes = Aeds.HeaderSize + WireLayouts.PageContentBlobOffset + WireLimits.PageContentBytes;

    public static (string Slug, string Markdown) DecodeUpdate(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, FrameType.PageContentUpdateRequest);
        if (payload.Length < WireLayouts.PageContentBlobOffset || frame.Length > MaxUpdateFrameBytes)
            throw new ProtocolException("Invalid site page payload size");

        var markdown = payload[WireLayouts.PageContentBlobOffset..];
        var lengths = payload[WireLayouts.PageContentSlugBytes..];
        if (BinaryPrimitives.ReadInt32LittleEndian(lengths) != 0 ||
            BinaryPrimitives.ReadInt32LittleEndian(lengths[4..]) != markdown.Length ||
            BinaryPrimitives.ReadInt32LittleEndian(lengths[8..]) != markdown.Length)
            throw new ProtocolException("Invalid site page Markdown slice");

        var slug = payload[..WireLayouts.PageContentSlugBytes];
        var terminator = slug.IndexOf((byte)0);
        if (terminator <= 0 || slug[terminator..].ContainsAnyExcept((byte)0) || markdown.Contains((byte)0))
            throw new ProtocolException("Invalid site page payload");

        try
        {
            var source = Utf8.GetString(markdown);
            if (source.Length > WireLimits.PageContentChars)
                throw new ProtocolException("Site page exceeds its character limit");
            return (Utf8.GetString(slug[..terminator]), source);
        }
        catch (DecoderFallbackException)
        {
            throw new ProtocolException("Invalid site page UTF-8");
        }
    }

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
