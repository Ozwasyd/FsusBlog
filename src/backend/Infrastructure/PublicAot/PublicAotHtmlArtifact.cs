using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public readonly record struct PublicAotHtmlArtifact(
    ReadOnlyMemory<byte> Utf8Bytes,
    string ETag,
    ReadOnlyMemory<byte> BrotliBytes,
    string BrotliETag,
    ReadOnlyMemory<byte> GzipBytes,
    string GzipETag,
    string ContentType,
    string CacheControl,
    string RendererVersion,
    string FrontendAssetVersion,
    bool RequiresCspNonceMutation)
{
    public bool IsEmpty => Utf8Bytes.IsEmpty;

    public static PublicAotHtmlArtifact Empty(string rendererVersion = "", string frontendAssetVersion = "")
        => new(
            ReadOnlyMemory<byte>.Empty,
            string.Empty,
            ReadOnlyMemory<byte>.Empty,
            string.Empty,
            ReadOnlyMemory<byte>.Empty,
            string.Empty,
            "text/html; charset=utf-8",
            PublicAotHtmlArtifactOptions.DefaultCacheControl,
            rendererVersion,
            frontendAssetVersion,
            RequiresCspNonceMutation: false);
}

public readonly record struct PublicAotHtmlArtifactVariant(
    ReadOnlyMemory<byte> Bytes,
    string ETag,
    string ContentEncoding);

public sealed class PublicAotHtmlArtifactOptions
{
    public const string DefaultCacheControl = "no-cache";
    public const int DefaultMinPrecompressedHtmlBytes = 1024;

    public bool EnablePrecompressedHtmlVariants { get; set; } = true;
    public int MinPrecompressedHtmlBytes { get; set; } = DefaultMinPrecompressedHtmlBytes;
    public string CacheControl { get; set; } = DefaultCacheControl;
}

internal static class PublicAotHtmlArtifactFactory
{
    private const string CspNonceTemplatePlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string HtmlContentType = "text/html; charset=utf-8";

    internal static PublicAotHtmlArtifact FromHtml(
        string html,
        string rendererVersion,
        string frontendAssetVersion,
        string cacheControl = PublicAotHtmlArtifactOptions.DefaultCacheControl,
        int minPrecompressedHtmlBytes = PublicAotHtmlArtifactOptions.DefaultMinPrecompressedHtmlBytes,
        bool enablePrecompressedVariants = true)
    {
        byte[] utf8 = Encoding.UTF8.GetBytes(html);
        string etag = CreateEtag(utf8);
        ReadOnlyMemory<byte> brotliBytes = ReadOnlyMemory<byte>.Empty;
        string brotliEtag = string.Empty;
        ReadOnlyMemory<byte> gzipBytes = ReadOnlyMemory<byte>.Empty;
        string gzipEtag = string.Empty;

        int minBytes = Math.Max(0, minPrecompressedHtmlBytes);
        if (enablePrecompressedVariants && utf8.Length >= minBytes)
        {
            byte[]? compressedBrotli = TryCompress(utf8, "br");
            if (compressedBrotli is { Length: > 0 })
            {
                brotliBytes = compressedBrotli;
                brotliEtag = CreateEtag(compressedBrotli);
            }

            byte[]? compressedGzip = TryCompress(utf8, "gzip");
            if (compressedGzip is { Length: > 0 })
            {
                gzipBytes = compressedGzip;
                gzipEtag = CreateEtag(compressedGzip);
            }
        }

        return new PublicAotHtmlArtifact(
            utf8,
            etag,
            brotliBytes,
            brotliEtag,
            gzipBytes,
            gzipEtag,
            HtmlContentType,
            string.IsNullOrWhiteSpace(cacheControl) ? PublicAotHtmlArtifactOptions.DefaultCacheControl : cacheControl,
            rendererVersion,
            frontendAssetVersion,
            RequiresCspNonceMutation(html));
    }

    internal static string CreateEtag(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"", Convert.ToHexStringLower(hash[..8]), "\"");
    }

    internal static bool RequiresCspNonceMutation(string html)
    {
        if (string.IsNullOrEmpty(html))
        {
            return false;
        }

        if (html.Contains(CspNonceTemplatePlaceholder, StringComparison.Ordinal)
            || ContainsTagWithoutNonce(html, "script")
            || ContainsTagWithoutNonce(html, "style"))
        {
            return true;
        }

        bool needsCspMeta = !html.Contains("property=\"csp-nonce\"", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("property='csp-nonce'", StringComparison.OrdinalIgnoreCase);
        return needsCspMeta && html.Contains("<head>", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsTagWithoutNonce(string html, string tagName)
    {
        int position = 0;
        while (position < html.Length)
        {
            int tagStart = html.IndexOf('<', position);
            if (tagStart < 0)
            {
                return false;
            }

            int tagEnd = html.IndexOf('>', tagStart);
            if (tagEnd < 0)
            {
                return false;
            }

            if (IsTagStart(html, tagStart, tagName) && !TagContainsNonce(html, tagStart, tagEnd))
            {
                return true;
            }

            position = tagEnd + 1;
        }

        return false;
    }

    private static bool IsTagStart(string html, int tagStart, string tagName)
    {
        int nameStart = tagStart + 1;
        return html.Length >= nameStart + tagName.Length
            && html.AsSpan(nameStart, tagName.Length).Equals(tagName, StringComparison.OrdinalIgnoreCase)
            && (html.Length == nameStart + tagName.Length
                || char.IsWhiteSpace(html[nameStart + tagName.Length])
                || html[nameStart + tagName.Length] is '>' or '/');
    }

    private static bool TagContainsNonce(string html, int tagStart, int tagEnd)
        => html.AsSpan(tagStart, tagEnd - tagStart + 1).IndexOf("nonce=".AsSpan(), StringComparison.OrdinalIgnoreCase) >= 0;

    private static byte[]? TryCompress(ReadOnlySpan<byte> bytes, string encoding)
    {
        using var output = new MemoryStream();
        if (encoding == "br")
        {
            using (var brotli = new BrotliStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                brotli.Write(bytes);
            }
        }
        else
        {
            using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                gzip.Write(bytes);
            }
        }

        return output.Length < bytes.Length ? output.ToArray() : null;
    }
}

internal static class PublicAotHtmlResponseNegotiation
{
    internal static bool TrySelectVariant(
        StringValues acceptEncoding,
        PublicAotHtmlArtifact artifact,
        out PublicAotHtmlArtifactVariant variant)
    {
        HtmlEncodingQuality quality = ParseAcceptEncoding(acceptEncoding);
        double identity = quality.Identity;
        double gzip = quality.Gzip;
        double br = quality.Brotli;

        variant = default;
        double best = -1;
        if (identity > 0 && !artifact.Utf8Bytes.IsEmpty)
        {
            variant = new PublicAotHtmlArtifactVariant(artifact.Utf8Bytes, artifact.ETag, string.Empty);
            best = identity;
        }

        if (gzip > best && gzip > 0 && !artifact.GzipBytes.IsEmpty)
        {
            variant = new PublicAotHtmlArtifactVariant(artifact.GzipBytes, artifact.GzipETag, "gzip");
            best = gzip;
        }

        if (br >= best && br > 0 && !artifact.BrotliBytes.IsEmpty)
        {
            variant = new PublicAotHtmlArtifactVariant(artifact.BrotliBytes, artifact.BrotliETag, "br");
            best = br;
        }

        return best > 0 && !variant.Bytes.IsEmpty;
    }

    internal static bool MatchesIfNoneMatch(StringValues ifNoneMatch, string etag)
    {
        if (string.IsNullOrWhiteSpace(etag) || ifNoneMatch.Count == 0)
        {
            return false;
        }

        for (int i = 0; i < ifNoneMatch.Count; i++)
        {
            ReadOnlySpan<char> header = (ifNoneMatch[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> candidate = (comma >= 0 ? header[..comma] : header).Trim();
                if (candidate.Equals("*", StringComparison.Ordinal)
                    || candidate.Equals(etag.AsSpan(), StringComparison.Ordinal))
                {
                    return true;
                }

                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        return false;
    }

    private readonly record struct HtmlEncodingQuality(double Identity, double Gzip, double Brotli);

    private static HtmlEncodingQuality ParseAcceptEncoding(StringValues values)
    {
        if (values.Count == 0)
        {
            return new HtmlEncodingQuality(1, 0, 0);
        }

        bool saw = false;
        double identity = -1;
        double gzip = -1;
        double br = -1;
        double wildcard = -1;
        for (int i = 0; i < values.Count; i++)
        {
            ReadOnlySpan<char> header = (values[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> segment = comma >= 0 ? header[..comma] : header;
                ReadEncodingSegment(segment, ref saw, ref identity, ref gzip, ref br, ref wildcard);
                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        if (!saw)
        {
            return new HtmlEncodingQuality(1, 0, 0);
        }

        if (identity < 0)
        {
            identity = wildcard >= 0 ? wildcard : 1;
        }

        if (gzip < 0)
        {
            gzip = wildcard >= 0 ? wildcard : 0;
        }

        if (br < 0)
        {
            br = wildcard >= 0 ? wildcard : 0;
        }

        return new HtmlEncodingQuality(identity, gzip, br);
    }

    private static void ReadEncodingSegment(
        ReadOnlySpan<char> segment,
        ref bool saw,
        ref double identity,
        ref double gzip,
        ref double br,
        ref double wildcard)
    {
        segment = segment.Trim();
        if (segment.IsEmpty)
        {
            return;
        }

        saw = true;
        int semicolon = segment.IndexOf(';');
        ReadOnlySpan<char> name = (semicolon >= 0 ? segment[..semicolon] : segment).Trim();
        double quality = semicolon >= 0 ? ParseQuality(segment[(semicolon + 1)..]) : 1;
        if (name.Equals("identity", StringComparison.OrdinalIgnoreCase))
        {
            identity = quality;
        }
        else if (name.Equals("gzip", StringComparison.OrdinalIgnoreCase))
        {
            gzip = quality;
        }
        else if (name.Equals("br", StringComparison.OrdinalIgnoreCase))
        {
            br = quality;
        }
        else if (name.Equals("*", StringComparison.OrdinalIgnoreCase))
        {
            wildcard = quality;
        }
    }

    private static double ParseQuality(ReadOnlySpan<char> parameters)
    {
        while (!parameters.IsEmpty)
        {
            int semicolon = parameters.IndexOf(';');
            ReadOnlySpan<char> parameter = (semicolon >= 0 ? parameters[..semicolon] : parameters).Trim();
            if (parameter.StartsWith("q=", StringComparison.OrdinalIgnoreCase)
                && double.TryParse(
                    parameter[2..],
                    System.Globalization.NumberStyles.AllowDecimalPoint,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out double quality))
            {
                return Math.Clamp(quality, 0, 1);
            }

            if (semicolon < 0)
            {
                break;
            }

            parameters = parameters[(semicolon + 1)..];
        }

        return 1;
    }
}
