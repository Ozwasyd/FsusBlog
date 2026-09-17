using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>
/// Provides canonical construction rules for public SEO head metadata.
/// </summary>
public static class PublicSeoHeadContract
{
    public const string Schema = "fsusblog.public-seo-head";
    public const int Version = 1;
}

/// <summary>
/// Defines the API output contract represented by <c>PublicSeoOpenGraphModel</c>.
/// </summary>
public sealed record class PublicSeoOpenGraphModel
{
    public string Title { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string Type { get; init; } = "website";
    public string Url { get; init; } = string.Empty;
    public string Locale { get; init; } = "zh_CN";
    public string? ImageUrl
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>PublicSeoTwitterCardModel</c>.
/// </summary>
public sealed record class PublicSeoTwitterCardModel
{
    public string Card { get; init; } = "summary_large_image";
    public string Title { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string? ImageUrl
    {
        get; init;
    }
}

/// <summary>
/// Versioned, transport-safe public-page SEO state shared by AOT composition and SPA takeover.
/// Digest is SHA-256 over the UTF-8 length-prefixed semantic fields in <see cref="ComputeDigest"/>.
/// </summary>
public sealed record class PublicSeoHeadModel
{
    public string Schema { get; init; } = PublicSeoHeadContract.Schema;
    public int Version { get; init; } = PublicSeoHeadContract.Version;
    public string Digest { get; init; } = string.Empty;
    public string DocumentTitle { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string CanonicalUrl { get; init; } = string.Empty;
    public string PublicOrigin { get; init; } = string.Empty;
    public string Robots { get; init; } = "index,follow";
    public string Locale { get; init; } = "zh-CN";
    public string PageType { get; init; } = string.Empty;
    public string PageEntityId { get; init; } = string.Empty;
    public PublicSeoOpenGraphModel OpenGraph { get; init; } = new();
    public PublicSeoTwitterCardModel Twitter { get; init; } = new();
    public string JsonLdGraph { get; init; } = string.Empty;
    public DateTimeOffset? ArticlePublishedAtUtc
    {
        get; init;
    }
    public DateTimeOffset? ArticleModifiedAtUtc
    {
        get; init;
    }
    public string? ArticleAuthor
    {
        get; init;
    }
    public string? ArticleImageUrl
    {
        get; init;
    }

    public PublicSeoHeadModel WithComputedDigest()
        => this with
        {
            Digest = ComputeDigest(this)
        };

    public bool HasValidContractAndDigest()
    {
        if (!string.Equals(Schema, PublicSeoHeadContract.Schema, StringComparison.Ordinal)
            || Version != PublicSeoHeadContract.Version
            || Digest is null
            || Digest.Length != 64
            || OpenGraph is null
            || Twitter is null)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(Digest.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(ComputeDigest(this)));
    }

    public IReadOnlyDictionary<string, object?> ToPayload()
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["schema"] = Schema,
            ["version"] = Version,
            ["digest"] = Digest,
            ["documentTitle"] = DocumentTitle,
            ["description"] = Description,
            ["canonicalUrl"] = CanonicalUrl,
            ["publicOrigin"] = PublicOrigin,
            ["robots"] = Robots,
            ["locale"] = Locale,
            ["pageType"] = PageType,
            ["pageEntityId"] = PageEntityId,
            ["openGraph"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["title"] = OpenGraph.Title,
                ["description"] = OpenGraph.Description,
                ["type"] = OpenGraph.Type,
                ["url"] = OpenGraph.Url,
                ["locale"] = OpenGraph.Locale,
                ["imageUrl"] = OpenGraph.ImageUrl
            },
            ["twitter"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["card"] = Twitter.Card,
                ["title"] = Twitter.Title,
                ["description"] = Twitter.Description,
                ["imageUrl"] = Twitter.ImageUrl
            },
            ["jsonLdGraph"] = JsonLdGraph,
            ["articlePublishedAtUtc"] = FormatDate(ArticlePublishedAtUtc),
            ["articleModifiedAtUtc"] = FormatDate(ArticleModifiedAtUtc),
            ["articleAuthor"] = ArticleAuthor,
            ["articleImageUrl"] = ArticleImageUrl
        };

    public static string ComputeDigest(PublicSeoHeadModel model)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, model.Schema);
        Append(hash, model.Version.ToString(CultureInfo.InvariantCulture));
        Append(hash, model.DocumentTitle);
        Append(hash, model.Description);
        Append(hash, model.CanonicalUrl);
        Append(hash, model.PublicOrigin);
        Append(hash, model.Robots);
        Append(hash, model.Locale);
        Append(hash, model.PageType);
        Append(hash, model.PageEntityId);
        Append(hash, model.OpenGraph.Title);
        Append(hash, model.OpenGraph.Description);
        Append(hash, model.OpenGraph.Type);
        Append(hash, model.OpenGraph.Url);
        Append(hash, model.OpenGraph.Locale);
        Append(hash, model.OpenGraph.ImageUrl);
        Append(hash, model.Twitter.Card);
        Append(hash, model.Twitter.Title);
        Append(hash, model.Twitter.Description);
        Append(hash, model.Twitter.ImageUrl);
        Append(hash, model.JsonLdGraph);
        Append(hash, FormatDate(model.ArticlePublishedAtUtc));
        Append(hash, FormatDate(model.ArticleModifiedAtUtc));
        Append(hash, model.ArticleAuthor);
        Append(hash, model.ArticleImageUrl);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static string? FormatDate(DateTimeOffset? value)
        => value?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static void Append(IncrementalHash hash, string? value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
        hash.AppendData(Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture)));
        hash.AppendData(":"u8);
        hash.AppendData(bytes);
    }
}
