using System.Text;
using System.Xml;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Bounds XML allocation and refuses CR input that canonical reparsing cannot preserve.</summary>
internal static class EpubXmlBudget
{
    internal const int MaximumBytes = 4 * 1024 * 1024;
    internal const int MaximumNodes = 50000;
    internal const int MaximumDepth = 64;

    internal static void Validate(string xml, long maximumBytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(xml) > Math.Min(maximumBytes, MaximumBytes))
        {
            throw new DocumentExportBudgetExceededException("EPUB XML exceeds its closed DOM byte budget.", "input-budget");
        }
        // The canonical sanitizer writes decoded CR literally; a second XML parse would
        // silently normalize it to LF. Refuse this unsupported input before that loss.
        if (xml.Contains('\r'))
        {
            throw new InvalidDataException("EPUB does not support carriage returns; code whitespace must not be normalized.");
        }
        try
        {
            using var source = new StringReader(xml);
            using XmlReader reader = XmlReader.Create(source, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = Math.Min(maximumBytes, MaximumBytes),
                MaxCharactersFromEntities = 0
            });
            int nodes = 0;
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (reader.Value.Contains('\r'))
                {
                    throw new InvalidDataException("EPUB does not support carriage-return references; code whitespace must not be normalized.");
                }
                if (++nodes > MaximumNodes || reader.Depth > MaximumDepth || reader.AttributeCount > 32)
                {
                    throw new DocumentExportBudgetExceededException("EPUB XML exceeds its node, depth or attribute budget.", "input-budget");
                }
            }
        }
        catch (XmlException exception)
        {
            throw new InvalidDataException("EPUB XML envelope is malformed.", exception);
        }
    }
}
