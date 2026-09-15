using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public static partial class RevisionSourceDiffVerifier
{
    public static bool Verify(RevisionComparePlanBundle bundle, RevisionSourceDiffResult result)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        ArgumentNullException.ThrowIfNull(result);
        if (!RevisionComparePlanVerifier.LocalBundleValid(bundle)
            || !result.IsSuccess
            || result.Receipt.Status != result.Status
            || !string.Equals(result.Receipt.ReasonCode, "accepted", StringComparison.Ordinal)
            || result.Receipt.SchemaVersion != RevisionCompareContract.SchemaVersion
            || !string.Equals(result.Receipt.EngineVersion, RevisionCompareContract.DiffEngineVersion, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.SegmenterVersion, RevisionSourceDiffEngine.SegmenterVersion, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.PlanDigest, bundle.Plan.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.BaseSourceDigest, bundle.BasePackage.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.CompareSourceDigest, bundle.ComparePackage.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(
                result.Receipt.BudgetDigest,
                RevisionSourceDiffEngine.CreateBudgetDigest(bundle.Plan.Budgets, bundle.Plan.Options),
                StringComparison.Ordinal)
            || !string.Equals(
                result.Receipt.AdmissionDigest,
                bundle.Plan.Admission.ContentDigest,
                StringComparison.Ordinal)
            || result.Receipt.BaseSourceByteCount != bundle.BasePackage.RawMarkdown.Length
            || result.Receipt.CompareSourceByteCount != bundle.ComparePackage.RawMarkdown.Length
            || result.Receipt.BaseLineCount != result.BaseLines.Length
            || result.Receipt.CompareLineCount != result.CompareLines.Length
            || result.Receipt.WordEditCount != result.Chunks.Sum(static chunk =>
                chunk.Hunks.Sum(static hunk => hunk.WordEdits.Length))
            || result.Receipt.HeadingCount != result.BaseHeadings.Length + result.CompareHeadings.Length
            || result.Receipt.ContextGroupCount != result.ContextGroups.Length
            || result.Receipt.HunkCount != result.Chunks.Sum(static chunk => chunk.Hunks.Length)
            || result.Receipt.ChunkCount != result.Chunks.Length
            || result.Receipt.HunkCount > bundle.Plan.Admission.HunkLimit
            || result.Receipt.ChunkCount > bundle.Plan.Budgets.MaxChunks
            || result.Chunks.Any(chunk => chunk.Hunks.IsDefaultOrEmpty
                || chunk.Hunks.Length > bundle.Plan.Budgets.MaxHunksPerChunk)
            || result.Receipt.TokenCount < 0
            || result.Receipt.TokenCount > bundle.Plan.Budgets.MaxTokenCount
            || result.AttemptReceipt.ElapsedMilliseconds < 0
            || result.AttemptReceipt.Status != result.Status
            || !string.Equals(
                result.AttemptReceipt.SemanticContentDigest,
                result.Receipt.ContentDigest,
                StringComparison.Ordinal)
            || result.AttemptReceipt != RevisionSourceDiffEngine.CreateAttemptReceipt(
                result.Receipt,
                result.AttemptReceipt.ElapsedMilliseconds))
        {
            return false;
        }
        bool structureIdentityValid = bundle.Plan.Options.HeadingNavigation
            ? !string.Equals(result.Receipt.StructureParserVersion, "not-requested", StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(result.Receipt.BaseStructureDigest)
                && !string.IsNullOrWhiteSpace(result.Receipt.CompareStructureDigest)
            : string.Equals(result.Receipt.StructureParserVersion, "not-requested", StringComparison.Ordinal)
                && string.IsNullOrEmpty(result.Receipt.BaseStructureDigest)
                && string.IsNullOrEmpty(result.Receipt.CompareStructureDigest)
                && result.BaseHeadings.IsEmpty
                && result.CompareHeadings.IsEmpty;
        if (!structureIdentityValid)
        {
            return false;
        }
        if (!ValidLines(result.BaseLines, bundle.BasePackage.RawMarkdown)
            || !ValidLines(result.CompareLines, bundle.ComparePackage.RawMarkdown))
        {
            return false;
        }
        if (!ValidHeadings(result.BaseHeadings, bundle.BasePackage.RawMarkdown, result.BaseLines)
            || !ValidHeadings(result.CompareHeadings, bundle.ComparePackage.RawMarkdown, result.CompareLines))
        {
            return false;
        }

        int baseCursor = 0;
        int compareCursor = 0;
        int baseLineCursor = 0;
        int compareLineCursor = 0;
        int hunkCount = 0;
        HashSet<string> headingIdentities = result.BaseHeadings
            .Concat(result.CompareHeadings)
            .Select(static heading => heading.IdentityDigest)
            .ToHashSet(StringComparer.Ordinal);
        for (int chunkIndex = 0; chunkIndex < result.Chunks.Length; chunkIndex++)
        {
            RevisionDiffChunk chunk = result.Chunks[chunkIndex];
            if (chunk.Index != chunkIndex
                || !string.Equals(
                    chunk.ContentDigest,
                    RevisionSourceDiffEngine.CreateChunkDigest(chunk.Index, chunk.Hunks),
                    StringComparison.Ordinal))
            {
                return false;
            }
            foreach (RevisionDiffHunk hunk in chunk.Hunks)
            {
                RevisionByteRange expectedBase = RangeFromLines(
                    result.BaseLines,
                    hunk.BaseStartLine,
                    hunk.BaseLineCount,
                    bundle.BasePackage.RawMarkdown.Length);
                RevisionByteRange expectedCompare = RangeFromLines(
                    result.CompareLines,
                    hunk.CompareStartLine,
                    hunk.CompareLineCount,
                    bundle.ComparePackage.RawMarkdown.Length);
                if (hunk.BaseStartLine != baseLineCursor
                    || hunk.CompareStartLine != compareLineCursor
                    || hunk.Base != expectedBase
                    || hunk.Compare != expectedCompare
                    || hunk.Base.Offset != baseCursor
                    || hunk.Compare.Offset != compareCursor
                    || hunk.Base.End > bundle.BasePackage.RawMarkdown.Length
                    || hunk.Compare.End > bundle.ComparePackage.RawMarkdown.Length
                    || hunk.Base.Offset < 0
                    || hunk.Compare.Offset < 0)
                {
                    return false;
                }
                bool kindValid = hunk.Kind switch
                {
                    RevisionDiffKind.Equal => hunk.Base.Length > 0
                        && hunk.Compare.Length > 0
                        && bundle.BasePackage.RawMarkdown.AsSpan(hunk.Base.Offset, hunk.Base.Length)
                            .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(hunk.Compare.Offset, hunk.Compare.Length)),
                    RevisionDiffKind.Insert => hunk.Base.Length == 0 && hunk.Compare.Length > 0,
                    RevisionDiffKind.Delete => hunk.Base.Length > 0 && hunk.Compare.Length == 0,
                    RevisionDiffKind.Replace => hunk.Base.Length > 0
                        && hunk.Compare.Length > 0
                        && !bundle.BasePackage.RawMarkdown.AsSpan(hunk.Base.Offset, hunk.Base.Length)
                            .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(hunk.Compare.Offset, hunk.Compare.Length)),
                    _ => false
                };
                if (!kindValid || hunk.HeadingIdentities.Any(identity => !headingIdentities.Contains(identity)))
                {
                    return false;
                }
                if (hunk.Kind != RevisionDiffKind.Replace && !hunk.WordEdits.IsEmpty)
                {
                    return false;
                }
                int baseWordCursor = hunk.Base.Offset;
                int compareWordCursor = hunk.Compare.Offset;
                foreach (RevisionDiffWordEdit word in hunk.WordEdits)
                {
                    if (word.Base.Length < 0
                        || word.Compare.Length < 0
                        || word.Base.Offset < baseWordCursor
                        || word.Compare.Offset < compareWordCursor
                        || word.Base.Offset > hunk.Base.End
                        || word.Compare.Offset > hunk.Compare.End
                        || word.Base.Length > hunk.Base.End - word.Base.Offset
                        || word.Compare.Length > hunk.Compare.End - word.Compare.Offset)
                    {
                        return false;
                    }
                    ReadOnlySpan<byte> baseGap = bundle.BasePackage.RawMarkdown.AsSpan(
                        baseWordCursor,
                        word.Base.Offset - baseWordCursor);
                    ReadOnlySpan<byte> compareGap = bundle.ComparePackage.RawMarkdown.AsSpan(
                        compareWordCursor,
                        word.Compare.Offset - compareWordCursor);
                    bool wordKindValid = word.Kind switch
                    {
                        RevisionDiffKind.Insert => word.Base.Length == 0 && word.Compare.Length > 0,
                        RevisionDiffKind.Delete => word.Base.Length > 0 && word.Compare.Length == 0,
                        RevisionDiffKind.Replace => word.Base.Length > 0
                            && word.Compare.Length > 0
                            && !bundle.BasePackage.RawMarkdown.AsSpan(word.Base.Offset, word.Base.Length)
                                .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(word.Compare.Offset, word.Compare.Length)),
                        _ => false
                    };
                    if (!baseGap.SequenceEqual(compareGap) || !wordKindValid)
                    {
                        return false;
                    }
                    baseWordCursor = word.Base.Offset + word.Base.Length;
                    compareWordCursor = word.Compare.Offset + word.Compare.Length;
                }
                if (!hunk.WordEdits.IsEmpty
                    && !bundle.BasePackage.RawMarkdown.AsSpan(baseWordCursor, hunk.Base.End - baseWordCursor)
                    .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(
                        compareWordCursor,
                        hunk.Compare.End - compareWordCursor)))
                {
                    return false;
                }
                baseCursor = hunk.Base.End;
                compareCursor = hunk.Compare.End;
                baseLineCursor += hunk.BaseLineCount;
                compareLineCursor += hunk.CompareLineCount;
                hunkCount++;
            }
        }
        if (baseCursor != bundle.BasePackage.RawMarkdown.Length
            || compareCursor != bundle.ComparePackage.RawMarkdown.Length
            || baseLineCursor != result.BaseLines.Length
            || compareLineCursor != result.CompareLines.Length
            || hunkCount != result.Receipt.HunkCount)
        {
            return false;
        }
        if (!ValidContextGroups(bundle, result))
        {
            return false;
        }
        long expectedMemory = ((long)bundle.BasePackage.RawMarkdown.Length + bundle.ComparePackage.RawMarkdown.Length) * 3L
            + ((long)result.BaseLines.Length + result.CompareLines.Length) * 128L
            + (result.BaseHeadings.Length + result.CompareHeadings.Length) * 96L
            + result.Receipt.HunkCount * 192L
            + result.Chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + result.ContextGroups.Length * 128L;
        long expectedOutput = result.Receipt.HunkCount * 192L
            + result.Chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + (result.BaseHeadings.Length + result.CompareHeadings.Length) * 96L
            + result.ContextGroups.Length * 128L
            + ((long)result.BaseLines.Length + result.CompareLines.Length) * 48L;
        if (result.Receipt.EstimatedMemoryBytes != expectedMemory
            || result.Receipt.EstimatedOutputBytes != expectedOutput
            || expectedMemory > bundle.Plan.Budgets.MaxMemoryBytes
            || expectedOutput > bundle.Plan.Budgets.MaxOutputBytes)
        {
            return false;
        }
        RevisionSourceDiffReceipt expected = RevisionSourceDiffEngine.CreateReceipt(
            bundle,
            result.Status,
            result.Receipt.ReasonCode,
            result.Receipt.StructureParserVersion,
            result.Receipt.BaseStructureDigest,
            result.Receipt.CompareStructureDigest,
            result.BaseLines,
            result.CompareLines,
            result.BaseHeadings,
            result.CompareHeadings,
            result.ContextGroups,
            result.Receipt.EstimatedMemoryBytes,
            result.Receipt.EstimatedOutputBytes,
            result.Receipt.TokenCount,
            result.Chunks);
        return expected == result.Receipt;
    }

}
