using System.Globalization;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Projects the existing canonical renderer's XHTML footnote graph. This reads
/// no article source and introduces no renderer, receipt or parsing authority.
/// </summary>
internal sealed record DocumentExportDocxFootnote(XElement Definition, XElement Reference, XElement BackReference)
{
    internal XElement ReadContent()
    {
        XElement content = new(Definition);
        content.Elements().Last().Remove();
        return content;
    }

    internal static bool HasClass(XElement element, string value)
        => ((string?)element.Attribute("class"))?.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Contains(value, StringComparer.Ordinal) == true;

    internal static DocumentExportDocxFootnote[] ReadGraph(XElement root)
    {
        XElement[] sections = root.Descendants().Where(element => HasClass(element, "footnotes")).ToArray();
        XElement[] references = root.Descendants().Where(element => HasClass(element, "footnote-ref")).ToArray();
        XElement[] backlinks = root.Descendants().Where(element => HasClass(element, "footnote-backref")).ToArray();
        if (root.Descendants().Any(element => element.Name.LocalName == "aside"
            && ((string?)element.Attribute("id"))?.StartsWith("footnote-", StringComparison.Ordinal) == true))
        {
            throw new InvalidDataException("DOCX requires the canonical renderer's list footnotes, not an alternate aside contract.");
        }
        if (sections.Length == 0 && references.Length == 0 && backlinks.Length == 0)
        {
            return [];
        }
        if (sections.Length != 1 || sections[0].Name.LocalName != "section" || sections[0].Parent != root
            || root.Elements().Last() != sections[0] || sections[0].Attributes().Count() != 1
            || (string?)sections[0].Attribute("class") != "footnotes")
        {
            throw new InvalidDataException("DOCX canonical footnote footer is missing, nested or malformed.");
        }
        XElement section = sections[0];
        XElement[] children = section.Elements().ToArray();
        if (children.Length != 2 || children[0].Name.LocalName != "hr" || children[0].HasAttributes || children[0].Nodes().Any()
            || children[1].Name.LocalName != "ol" || children[1].HasAttributes
            || section.Nodes().OfType<XText>().Any(text => !string.IsNullOrWhiteSpace(text.Value))
            || children[1].Nodes().OfType<XText>().Any(text => !string.IsNullOrWhiteSpace(text.Value)))
        {
            throw new InvalidDataException("DOCX canonical footnote footer is outside its closed shape.");
        }
        XElement[] definitions = children[1].Elements().ToArray();
        if (definitions.Length == 0 || references.Length != definitions.Length || backlinks.Length != definitions.Length)
        {
            throw new InvalidDataException("DOCX footnote definitions, references and backlinks are not one-to-one.");
        }
        var graph = new List<DocumentExportDocxFootnote>();
        for (int index = 0; index < definitions.Length; index++)
        {
            XElement definition = definitions[index];
            string id = (string?)definition.Attribute("id") ?? string.Empty;
            string suffix = id.StartsWith("fn-", StringComparison.Ordinal) ? id[3..] : string.Empty;
            XElement reference = references[index];
            XElement backlink = backlinks[index];
            if (definition.Name.LocalName != "li" || definition.Attributes().Count() != 1 || suffix.Length == 0
                || reference.Name.LocalName != "a" || reference.Attributes().Count() != 3
                || (string?)reference.Attribute("href") != "#" + id
                || (string?)reference.Attribute("id") != "fnref-" + suffix
                || (string?)reference.Attribute("class") != "footnote-ref" || reference.HasElements
                || reference.Value != (index + 1).ToString(CultureInfo.InvariantCulture)
                || reference.Parent?.Name.LocalName != "sup" || reference.Parent.HasAttributes
                || reference.Parent.Nodes().Count() != 1 || reference.Ancestors().Contains(section)
                || backlink.Name.LocalName != "a" || backlink.Parent != definition
                || definition.Nodes().Last() != backlink || backlink.Attributes().Count() != 2 || backlink.HasElements
                || (string?)backlink.Attribute("href") != "#fnref-" + suffix
                || (string?)backlink.Attribute("class") != "footnote-backref" || backlink.Value != "↩")
            {
                throw new InvalidDataException("DOCX canonical footnote reference/definition/navigation graph drifted.");
            }
            var note = new DocumentExportDocxFootnote(definition, reference, backlink);
            XElement content = note.ReadContent();
            if (string.IsNullOrWhiteSpace(content.Value)
                || content.Value.Contains("[Footnote content missing]", StringComparison.Ordinal)
                || content.Descendants().Any(child => child.Name.LocalName is not ("strong" or "b" or "em" or "i" or "u" or "s" or "del"
                    or "sup" or "sub" or "code" or "kbd" or "samp" or "span" or "br")
                    || child.Attribute("id") is not null))
            {
                throw new InvalidDataException("DOCX footnote content is missing or requires an unsupported relationship/block scope.");
            }
            graph.Add(note);
        }
        var recognized = references.ToHashSet();
        var ids = definitions.Select(element => "#" + (string)element.Attribute("id")!).ToHashSet(StringComparer.Ordinal);
        if (root.Descendants().Any(element => element.Name.LocalName == "a"
            && ids.Contains((string?)element.Attribute("href") ?? string.Empty) && !recognized.Contains(element)))
        {
            throw new InvalidDataException("DOCX footnote targets require the canonical reference semantics.");
        }
        return graph.ToArray();
    }
}
