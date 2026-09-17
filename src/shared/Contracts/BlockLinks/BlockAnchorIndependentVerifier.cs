namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>
/// Re-reads all three projections independently. It does not trust a builder result,
/// source offsets, rendered output, relation index, or a consumer-specific resolver.
/// </summary>
public static class BlockAnchorIndependentVerifier
{
    public static BlockAnchorVerificationResult Verify(BlockAnchorRoundTripCase? roundTrip)
    {
        var reasons = new List<string>();
        if (roundTrip is null)
        {
            reasons.Add("block_anchor_round_trip_missing");
            return Finish(roundTrip, string.Empty, string.Empty, string.Empty, reasons);
        }

        BlockAnchorValidationResult targetValidation = BlockAnchorContractValidator.Validate(roundTrip.Target);
        if (!targetValidation.IsValid)
        {
            reasons.Add(targetValidation.ReasonCode!);
            return Finish(roundTrip, string.Empty, string.Empty, string.Empty, reasons);
        }

        if (!BlockAnchorContractValidator.IsCanonicalSlug(roundTrip.CanonicalSlug))
        {
            reasons.Add("block_anchor_route_projection_invalid");
        }

        if (!BlockAnchorContractValidator.IsDisplayText(roundTrip.DisplayText))
        {
            reasons.Add("block_anchor_markdown_display_invalid");
        }

        string sourceMarker = BlockAnchorCodec.BuildSourceMarker(roundTrip.Target.AnchorId);
        string fragment = BlockAnchorCodec.BuildFragment(roundTrip.Target.AnchorId);
        string markdown = string.Empty;
        if (reasons.Count == 0)
        {
            BlockAnchorValidationResult built = BlockAnchorMarkdownBuilder.TryBuild(
                roundTrip.DisplayText,
                roundTrip.CanonicalSlug,
                roundTrip.Target,
                out string? builtMarkdown);
            if (!built.IsValid)
            {
                reasons.Add(built.ReasonCode!);
            }
            else
            {
                markdown = builtMarkdown!;
            }
        }

        BlockAnchorValidationResult source = BlockAnchorCodec.TryParseSourceMarker(
            sourceMarker,
            out BlockAnchorId sourceId);
        if (!source.IsValid || sourceId != roundTrip.Target.AnchorId)
        {
            reasons.Add(source.IsValid
                ? "block_anchor_source_round_trip_mismatch"
                : source.ReasonCode!);
        }

        BlockAnchorValidationResult parsedFragment = BlockAnchorCodec.TryParseFragment(
            fragment,
            out BlockAnchorId fragmentId);
        if (!parsedFragment.IsValid || fragmentId != roundTrip.Target.AnchorId)
        {
            reasons.Add(parsedFragment.IsValid
                ? "block_anchor_fragment_round_trip_mismatch"
                : parsedFragment.ReasonCode!);
        }

        if (markdown.Length > 0)
        {
            BlockAnchorValidationResult parsedMarkdown = BlockAnchorMarkdownParser.TryParse(
                markdown,
                out BlockAnchorMarkdownLink? link);
            if (!parsedMarkdown.IsValid
                || link is null
                || link.AnchorId != roundTrip.Target.AnchorId
                || link.DisplayText != roundTrip.DisplayText
                || link.RoutePath != string.Concat(
                    BlockAnchorSchemas.MarkdownRoutePrefix,
                    Uri.EscapeDataString(roundTrip.CanonicalSlug)))
            {
                reasons.Add(parsedMarkdown.IsValid
                    ? "block_anchor_markdown_round_trip_mismatch"
                    : parsedMarkdown.ReasonCode!);
            }
        }

        if (fragment.IndexOf('^') >= 0
            || markdown.Contains(string.Concat(BlockAnchorSchemas.UrlFragmentPrefix, BlockAnchorSchemas.SourceMarkerPrefix), StringComparison.Ordinal))
        {
            reasons.Add("block_anchor_alias_projection_detected");
        }

        return Finish(roundTrip, sourceMarker, fragment, markdown, reasons);
    }

    private static BlockAnchorVerificationResult Finish(
        BlockAnchorRoundTripCase? roundTrip,
        string sourceMarker,
        string fragment,
        string markdown,
        IReadOnlyList<string> reasons)
    {
        string digest = roundTrip is null
            ? BlockAnchorContractDigest.Compute(writer => writer.Add("block_anchor_round_trip_missing"))
            : BlockAnchorContractDigest.ComputeVerification(
                roundTrip,
                sourceMarker,
                fragment,
                markdown);
        return new BlockAnchorVerificationResult(
            BlockAnchorSchemas.VerificationReceipt,
            BlockAnchorSchemas.Version,
            reasons.Count == 0,
            reasons,
            BlockAnchorContractDigest.ComputeContract(),
            digest);
    }
}
