namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>
/// Encodes and parses the two exact marker projections owned by FsusUI #289.
/// It never decodes, normalizes, scans source, or infers an anchor from a route.
/// </summary>
public static class BlockAnchorCodec
{
    public static BlockAnchorValidationResult TryParseSourceMarker(
        string? marker,
        out BlockAnchorId id)
    {
        id = default;
        if (string.IsNullOrEmpty(marker))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_source_marker_missing");
        }

        if (marker[0] != BlockAnchorSchemas.SourceMarkerPrefix[0])
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_source_marker_prefix_mismatch");
        }

        if (marker.Length == 1)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_source_marker_empty");
        }

        if (marker[1] == '^' || marker.IndexOf('#') >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_source_marker_unsupported_syntax");
        }

        return BlockAnchorId.TryCreate(marker[1..], out id);
    }

    public static string BuildSourceMarker(BlockAnchorId id)
    {
        EnsureValid(id);
        return string.Concat(BlockAnchorSchemas.SourceMarkerPrefix, id.Value);
    }

    public static BlockAnchorValidationResult TryParseFragment(
        string? fragment,
        out BlockAnchorId id)
    {
        id = default;
        if (string.IsNullOrEmpty(fragment))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_fragment_missing");
        }

        if (fragment[0] != BlockAnchorSchemas.UrlFragmentPrefix[0])
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_fragment_prefix_mismatch");
        }

        if (fragment.Length == 1)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_fragment_empty");
        }

        if (fragment[1] == '^' || fragment.IndexOf('^') >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_fragment_source_marker_forbidden");
        }

        if (fragment.IndexOf('%') >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_fragment_percent_encoding_forbidden");
        }

        if (fragment.IndexOf('#', 1) >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_fragment_multiple_fragments");
        }

        return BlockAnchorId.TryCreate(fragment[1..], out id);
    }

    public static string BuildFragment(BlockAnchorId id)
    {
        EnsureValid(id);
        return string.Concat(BlockAnchorSchemas.UrlFragmentPrefix, id.Value);
    }

    /// <summary>
    /// Parses a raw URL or route only to obtain its canonical fragment. The path is never
    /// promoted to durable article identity, and percent-decoding is deliberately absent.
    /// </summary>
    public static BlockAnchorValidationResult TryParseUrl(
        string? url,
        out BlockAnchorId id)
    {
        id = default;
        if (string.IsNullOrEmpty(url))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_url_missing");
        }

        int fragmentStart = url.IndexOf('#');
        if (fragmentStart <= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_url_fragment_required");
        }

        if (url.IndexOf('#', fragmentStart + 1) >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_url_multiple_fragments");
        }

        string path = url[..fragmentStart];
        if (path.Contains(string.Concat("[", "["), StringComparison.Ordinal)
            || path.Contains(string.Concat("{", "#"), StringComparison.Ordinal)
            || path.IndexOf('<') >= 0
            || path.IndexOf('>') >= 0)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.UnsupportedSyntax,
                "block_anchor_url_unsupported_syntax");
        }

        return TryParseFragment(url[fragmentStart..], out id);
    }

    private static void EnsureValid(BlockAnchorId id)
    {
        BlockAnchorValidationResult validation = BlockAnchorContractValidator.Validate(id);
        if (!validation.IsValid)
        {
            throw new ArgumentException(validation.ReasonCode, nameof(id));
        }
    }
}

/// <summary>Named URL parser facade; all validation remains owned by <see cref="BlockAnchorCodec"/>.</summary>
public static class BlockAnchorUrlParser
{
    public static BlockAnchorValidationResult TryParseFragment(
        string? fragment,
        out BlockAnchorId id)
        => BlockAnchorCodec.TryParseFragment(fragment, out id);

    public static BlockAnchorValidationResult TryParseUrl(
        string? url,
        out BlockAnchorId id)
        => BlockAnchorCodec.TryParseUrl(url, out id);
}
