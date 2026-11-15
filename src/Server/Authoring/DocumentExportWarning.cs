using Markdig.Syntax;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record DocumentExportWarning(string Code, int Start, int Length, int Occurrences)
{
    internal static DocumentExportWarning[] Collect(string body, IEnumerable<(string Code, MarkdownObject Node)> findings)
    {
        var warnings = new Dictionary<string, DocumentExportWarning>(StringComparer.Ordinal);
        foreach (var (code, node) in findings)
        {
            var start = node.Span.Start;
            var end = Math.Min(node.Span.End, body.Length - 1);
            if (start < 0 || start > end) continue;
            var known = warnings.GetValueOrDefault(code);
            var count = (known?.Occurrences ?? 0) + 1;
            warnings[code] = known is not null && known.Start <= start
                ? known with { Occurrences = count } : new(code, start, end - start + 1, count);
        }
        return warnings.Values.OrderBy(value => value.Start).ThenBy(value => value.Code, StringComparer.Ordinal).ToArray();
    }
}
