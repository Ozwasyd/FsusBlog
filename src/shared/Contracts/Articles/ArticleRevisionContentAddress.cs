using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Contracts.Articles;

/// <summary>The current raw Markdown content-block identity, distinct from normalized canonical article hashes.</summary>
public readonly record struct ArticleRevisionContentAddress(string MarkdownContent, string ContentHash, int ByteLength)
{
    /// <summary>Preserves the original null-to-empty input, UTF-8 length and uppercase SHA-256 content-block key.</summary>
    public static ArticleRevisionContentAddress Compute(string? markdownContent)
    {
        string content = markdownContent ?? string.Empty;
        byte[] utf8 = Encoding.UTF8.GetBytes(content);
        string hash = Convert.ToHexString(SHA256.HashData(utf8));
        return new(content, hash, utf8.Length);
    }
}
