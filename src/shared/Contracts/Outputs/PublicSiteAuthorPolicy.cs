using System.Text;

namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>The existing current site-author configuration key and pure normalization.</summary>
public static class PublicSiteAuthorPolicy
{
    /// <summary>The persisted current site-author setting key.</summary>
    public const string ConfigurationKey = "Seo_Author";

    /// <summary>Resolves the original 20-byte normalized author or the existing current site identity default.</summary>
    public static string Resolve(string? value)
    {
        string author = TrimUtf8Bytes(value, 20);
        return string.IsNullOrWhiteSpace(author) ? PublicSiteIdentityDefaults.SiteAuthor : author;
    }

    /// <summary>Preserves the existing trimmed, rune-safe UTF-8 byte-bound normalization.</summary>
    public static string TrimUtf8Bytes(string? value, int maxBytes)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string normalized = value?.Trim() ?? string.Empty;
        if (Encoding.UTF8.GetByteCount(normalized) <= maxBytes)
        {
            return normalized;
        }

        StringBuilder builder = new(normalized.Length);
        int bytes = 0;
        foreach (Rune rune in normalized.EnumerateRunes())
        {
            int runeBytes = Encoding.UTF8.GetByteCount(rune.ToString());
            if (bytes + runeBytes > maxBytes)
            {
                break;
            }

            builder.Append(rune);
            bytes += runeBytes;
        }

        return builder.ToString();
    }
}
