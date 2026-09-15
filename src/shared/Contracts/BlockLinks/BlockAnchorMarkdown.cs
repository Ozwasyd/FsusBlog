namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>
/// Builds the one standard Markdown link shape. The slug is encoded as a route
/// projection; the validated anchor is appended byte-for-byte after the fragment marker.
/// </summary>
public static class BlockAnchorMarkdownBuilder
{
    public static BlockAnchorValidationResult TryBuild(
        string? displayText,
        string? canonicalSlug,
        ArticleBlockTarget? target,
        out string? markdown)
    {
        markdown = null;
        BlockAnchorValidationResult targetValidation = BlockAnchorContractValidator.Validate(target);
        if (!targetValidation.IsValid)
        {
            return targetValidation;
        }

        if (!BlockAnchorContractValidator.IsCanonicalSlug(canonicalSlug))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_route_projection_invalid");
        }

        if (!BlockAnchorContractValidator.IsDisplayText(displayText))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_display_invalid");
        }

        string encodedSlug = Uri.EscapeDataString(canonicalSlug!);
        markdown = string.Concat(
            "[",
            displayText,
            "](",
            BlockAnchorSchemas.MarkdownRoutePrefix,
            encodedSlug,
            BlockAnchorCodec.BuildFragment(target!.AnchorId),
            ")");
        return BlockAnchorValidationResult.Valid();
    }

    public static string Build(
        string displayText,
        string canonicalSlug,
        ArticleBlockTarget target)
    {
        BlockAnchorValidationResult validation = TryBuild(
            displayText,
            canonicalSlug,
            target,
            out string? markdown);
        return validation.IsValid
            ? markdown!
            : throw new ArgumentException(validation.ReasonCode, nameof(target));
    }

    public static string Build(
        string displayText,
        string canonicalSlug,
        BlockAnchorId anchorId,
        string articleIdentity)
    {
        BlockAnchorValidationResult target = ArticleBlockTarget.TryCreate(
            articleIdentity,
            anchorId.Value,
            out ArticleBlockTarget? value);
        return target.IsValid
            ? Build(displayText, canonicalSlug, value!)
            : throw new ArgumentException(target.ReasonCode, nameof(articleIdentity));
    }
}

/// <summary>Parses only the standard Markdown link projection and validates its raw fragment.</summary>
public static class BlockAnchorMarkdownParser
{
    public static BlockAnchorValidationResult TryParse(
        string? markdown,
        out BlockAnchorMarkdownLink? link)
    {
        link = null;
        if (string.IsNullOrEmpty(markdown))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_markdown_missing");
        }

        if (markdown.StartsWith(string.Concat("[", "["), StringComparison.Ordinal)
            || markdown.Contains(string.Concat("{", "#"), StringComparison.Ordinal)
            || markdown.Contains("<a", StringComparison.OrdinalIgnoreCase)
            || markdown.Contains("id=", StringComparison.OrdinalIgnoreCase))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_markdown_unsupported_syntax");
        }

        if (markdown[0] != '[' || markdown[^1] != ')')
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_shape_mismatch");
        }

        int destinationStart = markdown.IndexOf("](", StringComparison.Ordinal);
        if (destinationStart <= 1 || destinationStart + 2 >= markdown.Length - 1)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_shape_mismatch");
        }

        string displayText = markdown[1..destinationStart];
        BlockAnchorValidationResult displayValidation = BlockAnchorContractValidator.IsDisplayText(displayText)
            ? BlockAnchorValidationResult.Valid()
            : BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_display_invalid");
        if (!displayValidation.IsValid)
        {
            return displayValidation;
        }

        string destination = markdown[(destinationStart + 2)..^1];
        if (!destination.StartsWith(BlockAnchorSchemas.MarkdownRoutePrefix, StringComparison.Ordinal))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_route_prefix_mismatch");
        }

        int fragmentStart = destination.IndexOf('#');
        if (fragmentStart <= BlockAnchorSchemas.MarkdownRoutePrefix.Length
            || destination.IndexOf('#', fragmentStart + 1) >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_fragment_missing_or_ambiguous");
        }

        string routePath = destination[..fragmentStart];
        if (routePath.IndexOf('(') >= 0
            || routePath.IndexOf(')') >= 0
            || routePath.IndexOf('?') >= 0
            || routePath.IndexOf('^') >= 0
            || ContainsControl(routePath)
            || routePath.IndexOf(' ') >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_markdown_route_invalid");
        }

        BlockAnchorValidationResult fragment = BlockAnchorCodec.TryParseFragment(
            destination[fragmentStart..],
            out BlockAnchorId anchorId);
        if (!fragment.IsValid)
        {
            return fragment;
        }

        link = new BlockAnchorMarkdownLink(displayText, routePath, anchorId);
        return BlockAnchorValidationResult.Valid();
    }

    private static bool ContainsControl(string value)
    {
        foreach (char character in value)
        {
            if (char.IsControl(character))
            {
                return true;
            }
        }

        return false;
    }
}
