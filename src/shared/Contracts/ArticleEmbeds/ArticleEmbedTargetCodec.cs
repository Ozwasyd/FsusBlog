using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds;

/// <summary>
/// The single target-token codec. It consumes FsusUI #290 target/mode values and never parses Markdown source.
/// </summary>
public static class ArticleEmbedTargetCodec
{
    private const string ArticlePrefix = "article:";
    private const string HeadingPrefix = "heading:";

    public static ArticleEmbedValidationResult TryDecode(
        string? token,
        ArticleEmbedTargetKind mode,
        out ArticleEmbedTargetIdentity? target)
    {
        target = null;
        if (!Enum.IsDefined(mode))
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_mode_unknown");
        }
        if (string.IsNullOrEmpty(token))
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_target_missing");
        }

        int separator = token.IndexOf('#');
        if (separator >= 0 && token.IndexOf('#', separator + 1) >= 0)
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_target_ambiguous");
        }

        string article = separator < 0 ? token : token[..separator];
        string? fragment = separator < 0 ? null : token[(separator + 1)..];
        if (!IsNamespacedUuid(article, ArticlePrefix))
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_portable_article_identity_invalid");
        }

        string? heading = null;
        string? block = null;
        switch (mode)
        {
            case ArticleEmbedTargetKind.Article when fragment is not null:
                return ArticleEmbedValidationResult.Invalid("article_embed_article_fragment_forbidden");
            case ArticleEmbedTargetKind.Heading when !IsNamespacedUuid(fragment, HeadingPrefix):
                return ArticleEmbedValidationResult.Invalid("article_embed_heading_identity_invalid");
            case ArticleEmbedTargetKind.Heading:
                heading = fragment;
                break;
            case ArticleEmbedTargetKind.Block when !IsCanonicalBlockAnchor(fragment):
                return ArticleEmbedValidationResult.Invalid("article_embed_block_anchor_invalid");
            case ArticleEmbedTargetKind.Block:
                block = fragment;
                break;
        }

        target = new ArticleEmbedTargetIdentity(article, mode, heading, block);
        return ArticleEmbedValidationResult.Valid();
    }

    public static string Encode(ArticleEmbedTargetIdentity target)
    {
        ArticleEmbedValidationResult validation = Validate(target);
        if (!validation.IsValid)
        {
            throw new ArgumentException(validation.ReasonCode, nameof(target));
        }

        return target.Kind switch
        {
            ArticleEmbedTargetKind.Article => target.PortableArticleIdentity,
            ArticleEmbedTargetKind.Heading => $"{target.PortableArticleIdentity}#{target.HeadingIdentity}",
            ArticleEmbedTargetKind.Block => $"{target.PortableArticleIdentity}#{target.BlockAnchor}",
            _ => throw new ArgumentOutOfRangeException(nameof(target))
        };
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedTargetIdentity? target)
    {
        if (target is null)
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_target_missing");
        }

        ArticleEmbedValidationResult decoded = TryDecode(EncodeUnchecked(target), target.Kind, out ArticleEmbedTargetIdentity? reparsed);
        if (!decoded.IsValid)
        {
            return decoded;
        }
        return reparsed == target
            ? ArticleEmbedValidationResult.Valid()
            : ArticleEmbedValidationResult.Invalid("article_embed_target_shape_mismatch");
    }

    public static bool IsPortableArticleIdentity(string? value)
        => IsNamespacedUuid(value, ArticlePrefix);

    public static bool IsCanonicalHeadingIdentity(string? value)
        => IsNamespacedUuid(value, HeadingPrefix);

    public static bool IsCanonicalBlockAnchor(string? value)
        => BlockAnchorId.IsCanonical(value);

    private static string EncodeUnchecked(ArticleEmbedTargetIdentity target)
        => target.Kind switch
        {
            ArticleEmbedTargetKind.Article => target.PortableArticleIdentity,
            ArticleEmbedTargetKind.Heading => $"{target.PortableArticleIdentity}#{target.HeadingIdentity}",
            ArticleEmbedTargetKind.Block => $"{target.PortableArticleIdentity}#{target.BlockAnchor}",
            _ => target.PortableArticleIdentity
        };

    private static bool IsNamespacedUuid(string? value, string prefix)
    {
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }
        string candidate = value[prefix.Length..];
        return Guid.TryParseExact(candidate, "D", out Guid parsed)
            && parsed != Guid.Empty
            && candidate == parsed.ToString("D");
    }
}
