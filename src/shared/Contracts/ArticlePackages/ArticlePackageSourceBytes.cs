using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Describes the exact final newline without normalizing source bytes.</summary>
public enum ArticlePackageFinalNewline : byte
{
    None = 0,
    Lf = 1,
    CrLf = 2,
    Cr = 3
}

/// <summary>Closed byte metadata only; this is not a syntax or property snapshot authority.</summary>
public sealed record ArticlePackageByteMetadata(
    int ByteLength,
    string Sha256,
    bool HasUtf8Bom,
    int LfCount,
    int CrLfCount,
    int BareCrCount,
    ArticlePackageFinalNewline FinalNewline,
    int TrailingSpaceCount,
    int TrailingTabCount);

/// <summary>Reports safe, content-free byte-validation failures.</summary>
public readonly record struct ArticlePackageByteValidationResult(bool IsValid, string? ReasonCode)
{
    public static ArticlePackageByteValidationResult Valid() => new(true, null);

    public static ArticlePackageByteValidationResult Invalid(string reasonCode) => new(false, reasonCode);
}

/// <summary>
/// Inspects the original UTF-8 bytes and verifies all metadata against those same bytes.
/// It neither parses Markdown nor changes BOM, newlines, spaces, Unicode or source text.
/// </summary>
public static class ArticlePackageSourceBytes
{
    public const int MaximumByteLength = 32 * 1024 * 1024;

    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    public static ArticlePackageByteValidationResult Inspect(
        ReadOnlySpan<byte> source,
        out ArticlePackageByteMetadata? metadata)
    {
        metadata = null;
        if (source.Length > MaximumByteLength)
        {
            return ArticlePackageByteValidationResult.Invalid("article_package_source_byte_budget_exceeded");
        }

        bool hasBom = source.StartsWith(new byte[] { 0xef, 0xbb, 0xbf });
        ReadOnlySpan<byte> content = hasBom ? source[3..] : source;
        try
        {
            _ = s_strictUtf8.GetCharCount(content);
        }
        catch (DecoderFallbackException)
        {
            return ArticlePackageByteValidationResult.Invalid("article_package_source_invalid_utf8");
        }

        int lfCount = 0;
        int crLfCount = 0;
        int bareCrCount = 0;
        int trailingSpaceCount = 0;
        int trailingTabCount = 0;
        int pendingSpaces = 0;
        int pendingTabs = 0;
        for (int index = 0; index < content.Length; index++)
        {
            byte current = content[index];
            if (current is (byte)'\r' or (byte)'\n')
            {
                trailingSpaceCount += pendingSpaces;
                trailingTabCount += pendingTabs;
                pendingSpaces = 0;
                pendingTabs = 0;
                if (current == (byte)'\r')
                {
                    if (index + 1 < content.Length && content[index + 1] == (byte)'\n')
                    {
                        crLfCount++;
                        index++;
                    }
                    else
                    {
                        bareCrCount++;
                    }
                }
                else
                {
                    lfCount++;
                }
            }
            else if (current == (byte)' ')
            {
                pendingSpaces++;
            }
            else if (current == (byte)'\t')
            {
                pendingTabs++;
            }
            else
            {
                pendingSpaces = 0;
                pendingTabs = 0;
            }
        }

        trailingSpaceCount += pendingSpaces;
        trailingTabCount += pendingTabs;
        ArticlePackageFinalNewline finalNewline = ArticlePackageFinalNewline.None;
        if (content.Length > 0 && content[^1] == (byte)'\n')
        {
            finalNewline = content.Length > 1 && content[^2] == (byte)'\r'
                ? ArticlePackageFinalNewline.CrLf
                : ArticlePackageFinalNewline.Lf;
        }
        else if (content.Length > 0 && content[^1] == (byte)'\r')
        {
            finalNewline = ArticlePackageFinalNewline.Cr;
        }

        metadata = new ArticlePackageByteMetadata(
            source.Length,
            Convert.ToHexStringLower(SHA256.HashData(source)),
            hasBom,
            lfCount,
            crLfCount,
            bareCrCount,
            finalNewline,
            trailingSpaceCount,
            trailingTabCount);
        return ArticlePackageByteValidationResult.Valid();
    }

    public static ArticlePackageByteValidationResult Verify(
        ReadOnlySpan<byte> source,
        ArticlePackageByteMetadata? metadata)
    {
        ArticlePackageByteValidationResult inspection = Inspect(source, out ArticlePackageByteMetadata? actual);
        if (!inspection.IsValid)
        {
            return inspection;
        }

        return metadata is not null && metadata == actual
            ? ArticlePackageByteValidationResult.Valid()
            : ArticlePackageByteValidationResult.Invalid("article_package_source_byte_metadata_mismatch");
    }
}
