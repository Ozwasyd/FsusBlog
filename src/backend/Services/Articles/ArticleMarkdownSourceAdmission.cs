using System.Text;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Admits the exact Markdown source retained by drafts and revision updates. Source coordinates
/// and digests cannot survive trimming, truncation or replacement of invalid UTF-16 input.
/// </summary>
public static class ArticleMarkdownSourceAdmission
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    /// <summary>Preserves source verbatim within the existing character bound; invalid input is refused.</summary>
    public static string Require(string source, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(source);
        if (source.Length > ArticleProductionNormalizers.MaxContentLength)
        {
            throw new ArgumentOutOfRangeException(nameof(source), "article_markdown_source_too_long");
        }

        try
        {
            _ = s_strictUtf8.GetByteCount(source);
        }
        catch (EncoderFallbackException error)
        {
            throw new ArgumentException("article_markdown_source_invalid_utf16", nameof(source), error);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return source;
    }
}
