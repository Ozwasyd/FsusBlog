namespace FsusBlog.V2.Core.Extensions;

internal static class PureRenderContract
{
    internal const string Hook = "article.beforeRenderMarkdown";
    internal const int SourceBytes = 16 * 1024;
    internal const int MarkdownBytes = 16 * 1024;
}

internal sealed record PurePluginRequest(string Id, string Source, string Markdown, int TimeoutMs);
