using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    internal static string CreateChunkDigest(int index, ImmutableArray<RevisionDiffHunk> hunks)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, index);
        foreach (RevisionDiffHunk hunk in hunks)
        {
            RevisionCompareCanonical.Append(hash, (int)hunk.Kind);
            RevisionCompareCanonical.Append(hash, hunk.BaseStartLine);
            RevisionCompareCanonical.Append(hash, hunk.BaseLineCount);
            RevisionCompareCanonical.Append(hash, hunk.CompareStartLine);
            RevisionCompareCanonical.Append(hash, hunk.CompareLineCount);
            RevisionCompareCanonical.Append(hash, hunk.Base.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Base.Length);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Length);
            foreach (RevisionDiffWordEdit word in hunk.WordEdits)
            {
                RevisionCompareCanonical.Append(hash, (int)word.Kind);
                RevisionCompareCanonical.Append(hash, word.Base.Offset);
                RevisionCompareCanonical.Append(hash, word.Base.Length);
                RevisionCompareCanonical.Append(hash, word.Compare.Offset);
                RevisionCompareCanonical.Append(hash, word.Compare.Length);
            }
            foreach (string heading in hunk.HeadingIdentities)
            {
                RevisionCompareCanonical.Append(hash, heading);
            }
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    internal static string CreateContextGroupDigest(
        int index,
        bool collapsed,
        int baseStart,
        int baseCount,
        int compareStart,
        int compareCount,
        RevisionByteRange baseRange,
        RevisionByteRange compareRange)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, index);
        RevisionCompareCanonical.Append(hash, collapsed);
        RevisionCompareCanonical.Append(hash, baseStart);
        RevisionCompareCanonical.Append(hash, baseCount);
        RevisionCompareCanonical.Append(hash, compareStart);
        RevisionCompareCanonical.Append(hash, compareCount);
        RevisionCompareCanonical.Append(hash, baseRange.Offset);
        RevisionCompareCanonical.Append(hash, baseRange.Length);
        RevisionCompareCanonical.Append(hash, compareRange.Offset);
        RevisionCompareCanonical.Append(hash, compareRange.Length);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    internal static RevisionSourceDiffReceipt CreateReceipt(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode,
        string structureParserVersion,
        string baseStructureDigest,
        string compareStructureDigest,
        ImmutableArray<RevisionDiffLine> baseLines,
        ImmutableArray<RevisionDiffLine> compareLines,
        ImmutableArray<RevisionDiffHeading> baseHeadings,
        ImmutableArray<RevisionDiffHeading> compareHeadings,
        ImmutableArray<RevisionDiffContextGroup> contextGroups,
        long estimatedMemoryBytes,
        long estimatedOutputBytes,
        int tokenCount,
        ImmutableArray<RevisionDiffChunk> chunks)
    {
        int hunkCount = chunks.Sum(static chunk => chunk.Hunks.Length);
        int wordEditCount = chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk => hunk.WordEdits.Length));
        int headingCount = baseHeadings.Length + compareHeadings.Length;
        string budgetDigest = CreateBudgetDigest(bundle.Plan.Budgets, bundle.Plan.Options);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.SchemaVersion);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.DiffEngineVersion);
        RevisionCompareCanonical.Append(hash, SegmenterVersion);
        RevisionCompareCanonical.Append(hash, structureParserVersion);
        RevisionCompareCanonical.Append(hash, bundle.Plan.ContentDigest);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, baseStructureDigest);
        RevisionCompareCanonical.Append(hash, compareStructureDigest);
        RevisionCompareCanonical.Append(hash, budgetDigest);
        RevisionCompareCanonical.Append(hash, bundle.Plan.Admission.ContentDigest);
        RevisionCompareCanonical.Append(hash, (int)status);
        RevisionCompareCanonical.Append(hash, reasonCode);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.RawMarkdown.Length);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.RawMarkdown.Length);
        RevisionCompareCanonical.Append(hash, baseLines.Length);
        RevisionCompareCanonical.Append(hash, compareLines.Length);
        RevisionCompareCanonical.Append(hash, tokenCount);
        RevisionCompareCanonical.Append(hash, wordEditCount);
        RevisionCompareCanonical.Append(hash, headingCount);
        RevisionCompareCanonical.Append(hash, contextGroups.Length);
        RevisionCompareCanonical.Append(hash, hunkCount);
        RevisionCompareCanonical.Append(hash, chunks.Length);
        RevisionCompareCanonical.Append(hash, estimatedMemoryBytes);
        RevisionCompareCanonical.Append(hash, estimatedOutputBytes);
        foreach (RevisionDiffLine line in baseLines.Concat(compareLines))
        {
            RevisionCompareCanonical.Append(hash, line.Index);
            RevisionCompareCanonical.Append(hash, line.Content.Offset);
            RevisionCompareCanonical.Append(hash, line.Content.Length);
            RevisionCompareCanonical.Append(hash, line.Terminator.Offset);
            RevisionCompareCanonical.Append(hash, line.Terminator.Length);
            RevisionCompareCanonical.Append(hash, (int)line.TerminatorKind);
        }
        foreach (RevisionDiffHeading heading in baseHeadings.Concat(compareHeadings))
        {
            RevisionCompareCanonical.Append(hash, heading.Level);
            RevisionCompareCanonical.Append(hash, heading.LineIndex);
            RevisionCompareCanonical.Append(hash, heading.Source.Offset);
            RevisionCompareCanonical.Append(hash, heading.Source.Length);
            RevisionCompareCanonical.Append(hash, heading.IdentityDigest);
        }
        foreach (RevisionDiffContextGroup group in contextGroups)
        {
            RevisionCompareCanonical.Append(hash, group.ContentDigest);
        }
        foreach (RevisionDiffChunk chunk in chunks)
        {
            RevisionCompareCanonical.Append(hash, chunk.ContentDigest);
        }
        return new RevisionSourceDiffReceipt(
            RevisionCompareContract.SchemaVersion,
            RevisionCompareContract.DiffEngineVersion,
            SegmenterVersion,
            structureParserVersion,
            status,
            reasonCode,
            bundle.Plan.ContentDigest,
            bundle.BasePackage.SourceDigest,
            bundle.ComparePackage.SourceDigest,
            baseStructureDigest,
            compareStructureDigest,
            budgetDigest,
            bundle.Plan.Admission.ContentDigest,
            bundle.BasePackage.RawMarkdown.Length,
            bundle.ComparePackage.RawMarkdown.Length,
            baseLines.Length,
            compareLines.Length,
            tokenCount,
            wordEditCount,
            headingCount,
            contextGroups.Length,
            hunkCount,
            chunks.Length,
            estimatedMemoryBytes,
            estimatedOutputBytes,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

    internal static string CreateBudgetDigest(RevisionCompareBudgets budgets, RevisionCompareOptions options)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareCanonical.BudgetDigest(budgets));
        RevisionCompareCanonical.Append(hash, RevisionCompareCanonical.OptionsDigest(options));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static RevisionSourceDiffResult Failure(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode)
    {
        RevisionSourceDiffReceipt receipt = CreateReceipt(
            bundle,
            status,
            reasonCode,
            "not-requested",
            string.Empty,
            string.Empty,
            [],
            [],
            [],
            [],
            [],
            0,
            0,
            0,
            []);
        return new RevisionSourceDiffResult(status, [], [], [], [], [], [], receipt, CreateAttemptReceipt(receipt, 0));
    }

    private static RevisionSourceDiffResult WithElapsed(RevisionSourceDiffResult result, long elapsedMilliseconds)
        => result with
        {
            AttemptReceipt = CreateAttemptReceipt(result.Receipt, elapsedMilliseconds)
        };

    internal static RevisionSourceDiffAttemptReceipt CreateAttemptReceipt(
        RevisionSourceDiffReceipt semanticReceipt,
        long elapsedMilliseconds)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, semanticReceipt.ContentDigest);
        RevisionCompareCanonical.Append(hash, (int)semanticReceipt.Status);
        RevisionCompareCanonical.Append(hash, elapsedMilliseconds);
        return new RevisionSourceDiffAttemptReceipt(
            semanticReceipt.ContentDigest,
            semanticReceipt.Status,
            elapsedMilliseconds,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

}
