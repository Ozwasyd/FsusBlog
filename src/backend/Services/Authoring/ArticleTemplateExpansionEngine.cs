using System.Globalization;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The single closed variable expansion engine. It performs byte-exact marker substitution
/// only: no helpers, functions, loops, conditionals, includes, eval, HTML rendering, or
/// normalization of the surrounding Markdown source. Identical inputs recompute identical
/// expanded bytes and digests on every run.
/// </summary>
internal static class ArticleTemplateExpansionEngine
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    /// <summary>ASCII punctuation that CommonMark allows to be backslash-escaped.</summary>
    private const string EscapablePunctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

    internal static string Marker(ArticleTemplateVariableToken token)
        => token switch
        {
            ArticleTemplateVariableToken.Title => "{{title}}",
            ArticleTemplateVariableToken.Date => "{{date}}",
            ArticleTemplateVariableToken.Author => "{{author}}",
            ArticleTemplateVariableToken.SiteLocale => "{{site_locale}}",
            _ => throw new ArticleTemplateValidationException("article_template_variable_unknown")
        };

    /// <summary>
    /// Escapes an interpolated text value: rejects control characters outright and
    /// backslash-escapes every CommonMark punctuation byte so a value can never grow
    /// structure inside the Markdown source.
    /// </summary>
    internal static string EscapeValue(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var builder = new StringBuilder(value.Length);
        foreach (char character in value)
        {
            if (char.IsControl(character))
            {
                throw new ArticleTemplateValidationException("article_template_expansion_value_control_character");
            }
            if (character < 0x80 && EscapablePunctuation.IndexOf(character) >= 0)
            {
                builder.Append('\\');
            }
            builder.Append(character);
        }
        return builder.ToString();
    }

    /// <summary>
    /// Substitutes every declared variable marker in declaration order. The source was already
    /// closed-validated, so each occurrence of a known marker is replaced and no unknown
    /// marker can survive. All other bytes are preserved verbatim (BOM, newline style,
    /// trailing whitespace, final-newline presence).
    /// </summary>
    internal static byte[] Expand(
        ArticleTemplateSource source,
        Func<ArticleTemplateVariableToken, string> resolve)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(resolve);
        string text = s_strictUtf8.GetString(source.AsSpan());
        foreach (ArticleTemplateVariableToken token in source.VariableTokens.Distinct())
        {
            string marker = Marker(token);
            string value = resolve(token);
            text = text.Replace(marker, value, StringComparison.Ordinal);
        }
        return s_strictUtf8.GetBytes(text);
    }

    /// <summary>Formats the business date for {{date}}: yyyy-MM-dd in the input time zone.</summary>
    internal static string FormatBusinessDate(DateTimeOffset businessTimeUtc, string timeZoneId)
    {
        TimeZoneInfo zone = TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
        DateTimeOffset local = TimeZoneInfo.ConvertTime(businessTimeUtc, zone);
        return local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }
}
