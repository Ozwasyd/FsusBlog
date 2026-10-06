namespace FsusBlog.Core.Services.Articles;

public static partial class RevisionSourceDiffVerifier
{
    private static bool TryEstimateMemory(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult result,
        out long expectedMemory,
        out int expectedTokenCount)
    {
        expectedMemory = 0;
        expectedTokenCount = 0;
        try
        {
            RevisionSourceDiffEngine.MemoryBudget memory = RevisionSourceDiffEngine.BeginMemoryBudget(
                bundle, result.BaseHeadings.Length, result.CompareHeadings.Length);
            // Independently reconstruct the line matching window from verified
            // raw ranges rather than trusting a receipt's workspace count.
            int prefix = 0;
            while (prefix < result.BaseLines.Length && prefix < result.CompareLines.Length
                && SameLine(bundle, result, prefix, prefix))
            {
                prefix++;
            }
            int suffix = 0;
            while (suffix < result.BaseLines.Length - prefix && suffix < result.CompareLines.Length - prefix
                && SameLine(bundle, result,
                    result.BaseLines.Length - suffix - 1, result.CompareLines.Length - suffix - 1))
            {
                suffix++;
            }
            int changedLines = result.BaseLines.Length + result.CompareLines.Length - 2 * (prefix + suffix);
            using (memory.Reserve(RevisionSourceDiffEngine.LineWorkspaceBytes(changedLines)))
            {
                // Only replay the conservative accounting; never rerun matching
                // or allocate token records, dictionaries, hunks or source output.
            }
            foreach (RevisionDiffChunk chunk in result.Chunks)
            {
                foreach (RevisionDiffHunk hunk in chunk.Hunks)
                {
                    memory.Retain(192L);
                    if (hunk.Kind == RevisionDiffKind.Replace)
                    {
                        using var decoded = memory.Reserve(
                            RevisionSourceDiffEngine.DecodedWordBytes(hunk.Base.Length, hunk.Compare.Length));
                        RevisionSourceDiffEngine.WordTokenization prepared = RevisionSourceDiffEngine.PrepareWordTokenization(
                            bundle.BasePackage.RawMarkdown.AsSpan(hunk.Base.Offset, hunk.Base.Length),
                            bundle.ComparePackage.RawMarkdown.AsSpan(hunk.Compare.Offset, hunk.Compare.Length),
                            bundle.Plan.Budgets.MaxTokenCount - expectedTokenCount);
                        if (prepared.Status == RevisionSourceDiffEngine.TokenizationStatus.BudgetExceeded)
                        {
                            return false;
                        }
                        if (prepared.Status == RevisionSourceDiffEngine.TokenizationStatus.InvalidUtf8
                            && !hunk.WordEdits.IsEmpty)
                        {
                            return false;
                        }
                        if (prepared.Status == RevisionSourceDiffEngine.TokenizationStatus.Available)
                        {
                            int tokens = prepared.BaseCount + prepared.CompareCount;
                            using var workspace = memory.Reserve(RevisionSourceDiffEngine.TokenWorkspaceBytes(
                                tokens, prepared.BaseText.Length + prepared.CompareText.Length));
                            memory.Retain(hunk.WordEdits.Length * 192L);
                            expectedTokenCount += tokens;
                        }
                    }
                    using (memory.Reserve(RevisionSourceDiffEngine.HeadingWorkspaceBytes(
                        result.BaseHeadings.Length + result.CompareHeadings.Length)))
                    {
                        memory.Retain(hunk.HeadingIdentities.Length * 72L);
                    }
                }
            }
            memory.Retain(result.ContextGroups.Length * 384L);
            memory.Retain(result.Chunks.Length * 256L);
            expectedMemory = memory.PeakBytes;
            return true;
        }
        catch (RevisionSourceDiffEngine.MemoryBudgetExceededException)
        {
            return false;
        }
    }

    private static bool SameLine(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult result,
        int baseIndex,
        int compareIndex)
    {
        RevisionDiffLine left = result.BaseLines[baseIndex];
        RevisionDiffLine right = result.CompareLines[compareIndex];
        return bundle.BasePackage.RawMarkdown.AsSpan(left.Content.Offset, left.Content.Length + left.Terminator.Length)
            .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(
                right.Content.Offset, right.Content.Length + right.Terminator.Length));
    }
}
