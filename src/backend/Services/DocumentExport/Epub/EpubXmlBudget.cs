using System.Text;
using System.Xml;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Bounds canonical XHTML/XML allocation before constructing any DOM.</summary>
internal static class EpubXmlBudget
{
    internal const int MaximumBytes = 4 * 1024 * 1024;
    internal const int MaximumNodes = 50000;
    internal const int MaximumDepth = 64;

    internal static void Validate(string xml, long maximumBytes, CancellationToken cancellationToken)
    {
        if (Encoding.UTF8.GetByteCount(xml) > Math.Min(maximumBytes, MaximumBytes))
        {
            throw new DocumentExportBudgetExceededException("EPUB XML exceeds its closed DOM byte budget.", "input-budget");
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
