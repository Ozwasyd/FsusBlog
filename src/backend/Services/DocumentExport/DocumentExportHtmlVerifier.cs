using System.Security.Cryptography;
using System.Text;
using System.Xml;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Independent streaming verification of the packaged artifact. This verifies
/// browser-facing closure and metadata without reusing sanitizer decisions.
/// </summary>
internal static class DocumentExportHtmlVerifier
{
    private static ReadOnlySpan<byte> Doctype => "<!doctype html>\n"u8;

    internal static string BuildCsp(string styleHash)
        => "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; "
            + "child-src 'none'; worker-src 'none'; connect-src 'none'; media-src 'none'; "
            + "manifest-src 'none'; img-src data:; font-src data:; "
            + $"style-src 'sha256-{styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    internal static void Validate(
        byte[] bytes,
        DocumentExportFrozenInput input,
        long maximumBytes)
    {
        if (bytes.Length <= Doctype.Length
            || bytes.Length > maximumBytes
            || !bytes.AsSpan(0, Doctype.Length).SequenceEqual(Doctype)
            || bytes.AsSpan().Contains((byte)'\r'))
        {
            throw new InvalidDataException("Self-contained HTML encoding, doctype, or output budget drifted.");
        }

        byte[] expectedStyle = DocumentExportReadingStyleAuthority.BuildStyleBytes(
            input.Assets,
            input.ThemeProfile,
            maximumBytes);
        byte[] expectedStyleDigest = SHA256.HashData(expectedStyle);
        string expectedStyleHash = Convert.ToBase64String(expectedStyleDigest);
        string expectedCsp = BuildCsp(expectedStyleHash);
        string expectedDirection = System.Globalization.CultureInfo.GetCultureInfo(input.Locale).TextInfo.IsRightToLeft
            ? "rtl"
            : "ltr";

        XmlReaderSettings settings = new()
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            ConformanceLevel = ConformanceLevel.Document,
            IgnoreComments = false,
            IgnoreProcessingInstructions = false,
            MaxCharactersInDocument = maximumBytes,
            MaxCharactersFromEntities = 0
        };

        int htmlCount = 0;
        int headCount = 0;
        int bodyCount = 0;
        int mainCount = 0;
        int articleCount = 0;
        int titleCount = 0;
        int styleCount = 0;
        int charsetCount = 0;
        int viewportCount = 0;
        int cspCount = 0;
        int authorityCount = 0;
        bool inHead = false;
        bool inStyle = false;
        using IncrementalHash styleDigest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        try
        {
            using var source = new MemoryStream(
                bytes,
                Doctype.Length,
                bytes.Length - Doctype.Length,
                writable: false,
                publiclyVisible: false);
            using var text = new StreamReader(source, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false);
            using XmlReader reader = XmlReader.Create(text, settings);
            while (reader.Read())
            {
                switch (reader.NodeType)
                {
                    case XmlNodeType.Element:
                        VerifyElement(reader);
                        switch (reader.LocalName)
                        {
                            case "html":
                                htmlCount++;
                                if (reader.NamespaceURI.Length != 0 || reader.Depth != 0
                                    || reader.GetAttribute("lang") != input.Locale
                                    || reader.GetAttribute("dir") != expectedDirection
                                    || reader.AttributeCount != 2)
                                {
                                    throw new InvalidDataException("Self-contained HTML root locale or direction drifted.");
                                }
                                break;
                            case "head":
                                if (reader.NamespaceURI.Length != 0 || reader.Depth != 1)
                                {
                                    throw new InvalidDataException("The HTML head must belong directly to the document root.");
                                }
                                headCount++;
                                inHead = true;
                                break;
                            case "body":
                                bodyCount++;
                                break;
                            case "main":
                                mainCount++;
                                break;
                            case "article":
                                articleCount++;
                                break;
                            case "title":
                                // SVG titles name diagrams; only the canonical HTML
                                // title directly owned by this page's head is metadata.
                                if (reader.NamespaceURI == "http://www.w3.org/2000/svg")
                                {
                                    break;
                                }
                                if (reader.NamespaceURI.Length != 0 || !inHead || reader.Depth != 2
                                    || reader.AttributeCount != 0)
                                {
                                    throw new InvalidDataException("The page title must belong directly to the HTML head.");
                                }
                                titleCount++;
                                break;
                            case "style":
                                styleCount++;
                                inStyle = true;
                                break;
                            case "meta":
                                ClassifyMeta(
                                    reader,
                                    input,
                                    expectedCsp,
                                    ref charsetCount,
                                    ref viewportCount,
                                    ref cspCount,
                                    ref authorityCount);
                                break;
                        }
                        break;
                    case XmlNodeType.EndElement:
                        if (reader.LocalName == "head" && reader.NamespaceURI.Length == 0 && reader.Depth == 1)
                        {
                            inHead = false;
                        }
                        if (reader.LocalName == "style")
                        {
                            inStyle = false;
                        }
                        break;
                    case XmlNodeType.Text:
                    case XmlNodeType.SignificantWhitespace:
                    case XmlNodeType.Whitespace:
                        if (inStyle)
                        {
                            AppendUtf8(styleDigest, reader.Value);
                        }
                        break;
                    case XmlNodeType.Comment:
                    case XmlNodeType.ProcessingInstruction:
                    case XmlNodeType.CDATA:
                    case XmlNodeType.DocumentType:
                    case XmlNodeType.EntityReference:
                        throw new InvalidDataException("Self-contained HTML contains a prohibited document node.");
                }
            }
        }
        catch (Exception exception) when (exception is XmlException or DecoderFallbackException)
        {
            throw new InvalidDataException("Self-contained HTML is not independently stream-parseable.", exception);
        }

        byte[] actualStyleDigest = styleDigest.GetHashAndReset();
        if (htmlCount != 1 || headCount != 1 || bodyCount != 1 || mainCount != 1 || articleCount != 1
            || titleCount != 1 || styleCount != 1 || charsetCount != 1 || viewportCount != 1
            || cspCount != 1 || authorityCount != 1
            || !actualStyleDigest.AsSpan().SequenceEqual(expectedStyleDigest))
        {
            throw new InvalidDataException("Self-contained HTML structure, style, CSP, or authority metadata drifted.");
        }
    }

    private static void VerifyElement(XmlReader reader)
    {
        string name = reader.LocalName;
        if (reader.IsEmptyElement && reader.NamespaceURI != "http://www.w3.org/2000/svg"
            && name is not ("meta" or "img" or "br" or "hr"))
        {
            throw new InvalidDataException("Non-void HTML elements require explicit closing tags for HTML5 semantics.");
        }
        if (name is "script" or "link" or "base" or "iframe" or "frame" or "object" or "embed"
            or "form" or "input" or "button" or "textarea" or "select" or "audio" or "video" or "source")
        {
            throw new InvalidDataException($"Self-contained HTML contains active element '{name}'.");
        }
        if (!reader.HasAttributes)
        {
            return;
        }
        while (reader.MoveToNextAttribute())
        {
            string attributeName = reader.Name;
            string value = reader.Value;
            if (attributeName.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                || attributeName is "style" or "srcset" or "srcdoc" or "formaction" or "poster"
                || attributeName == "src" && !value.StartsWith("data:image/", StringComparison.Ordinal)
                || attributeName == "href" && !SafeHref(value))
            {
                throw new InvalidDataException($"Self-contained HTML contains active attribute '{attributeName}'.");
            }
        }
        reader.MoveToElement();
    }

    private static bool SafeHref(string value)
    {
        if (value.StartsWith('#'))
        {
            return value.Length > 1;
        }
        return Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            && uri.UserInfo.Length == 0;
    }

    private static void ClassifyMeta(
        XmlReader reader,
        DocumentExportFrozenInput input,
        string expectedCsp,
        ref int charsetCount,
        ref int viewportCount,
        ref int cspCount,
        ref int authorityCount)
    {
        if (reader.AttributeCount == 1 && reader.GetAttribute("charset") == "utf-8")
        {
            charsetCount++;
            return;
        }
        if (reader.AttributeCount == 2
            && reader.GetAttribute("name") == "viewport"
            && reader.GetAttribute("content") == "width=device-width,initial-scale=1")
        {
            viewportCount++;
            return;
        }
        if (reader.AttributeCount == 2
            && reader.GetAttribute("http-equiv") == "Content-Security-Policy"
            && reader.GetAttribute("content") == expectedCsp)
        {
            cspCount++;
            return;
        }
        if (reader.AttributeCount == 2
            && reader.GetAttribute("name") == "fsus-reading-authority"
            && reader.GetAttribute("content") == input.ReadingStyleAuthorityDigest)
        {
            authorityCount++;
            return;
        }
        throw new InvalidDataException("Self-contained HTML contains unknown or drifted metadata.");
    }

    private static void AppendUtf8(IncrementalHash hash, string value)
    {
        int maximum = Encoding.UTF8.GetMaxByteCount(value.Length);
        byte[] rented = System.Buffers.ArrayPool<byte>.Shared.Rent(maximum);
        try
        {
            int length = Encoding.UTF8.GetBytes(value, rented);
            hash.AppendData(rented, 0, length);
        }
        finally
        {
            System.Buffers.ArrayPool<byte>.Shared.Return(rented);
        }
    }
}
