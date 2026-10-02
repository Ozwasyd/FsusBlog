using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    // These are conservative managed-workspace envelopes, not process RSS or GC
    // allocation counters. They include object/array headers, 64-bit references,
    // simultaneous old/new collection storage during growth and immutable copies.
    // Package bytes and canonical structure snapshots keep their existing owners.
    internal sealed class MemoryBudget
    {
        private readonly long _limit;
        private long _liveBytes;

        internal MemoryBudget(long limit)
        {
            _limit = limit;
        }

        internal long PeakBytes { get; private set; }

        internal void Retain(long bytes)
        {
            if (bytes < 0 || bytes > _limit - _liveBytes)
            {
                throw new MemoryBudgetExceededException(_liveBytes + bytes);
            }
            _liveBytes += bytes;
            PeakBytes = Math.Max(PeakBytes, _liveBytes);
        }

        internal Reservation Reserve(long bytes)
        {
            Retain(bytes);
            return new Reservation(this, bytes);
        }

        internal readonly struct Reservation(MemoryBudget owner, long bytes) : IDisposable
        {
            public void Dispose()
            {
                owner._liveBytes -= bytes;
            }
        }
    }

    internal sealed class MemoryBudgetExceededException(long requestedBytes) : Exception
    {
        internal long RequestedBytes { get; } = requestedBytes;
    }

    internal static MemoryBudget BeginMemoryBudget(
        RevisionComparePlanBundle bundle,
        int baseHeadingCount,
        int compareHeadingCount)
    {
        var memory = new MemoryBudget(bundle.Plan.Budgets.MaxMemoryBytes);
        // Per-line 192 includes source-line builder growth/copy, retained line
        // edits, projected line objects/arrays and hunk-reference builders.
        // The fixed envelope covers
        // bounded enumerators, encoders, hashing and receipt objects.
        memory.Retain(16 * 1024L
            + ((long)bundle.BasePackage.RawMarkdown.Length + bundle.ComparePackage.RawMarkdown.Length) * 3L
            + ((long)bundle.Plan.Admission.BaseLineCount + bundle.Plan.Admission.CompareLineCount) * 192L
            + ((long)baseHeadingCount + compareHeadingCount) * 160L);
        return memory;
    }

    internal static long LineWorkspaceBytes(int changedLineCount)
        // Occurrence dictionary entries/buckets including resize overlap,
        // candidate/anchor lists, sort/LIS arrays and returned anchor storage.
        => 512L + changedLineCount * 256L;

    internal static long DecodedWordBytes(int baseBytes, int compareBytes)
        // Strict UTF-8 needs at most one UTF-16 code unit per input byte.
        => 512L + ((long)baseBytes + compareBytes) * 2L;

    internal static long TokenWorkspaceBytes(int tokenCount, int charCount)
        // Per token: record 48, string header/alignment 32, reference-list
        // growth/copy 24, dictionary growth overlap 112, anchors/LIS 56 and
        // word-edit records, byte-range objects and builder/copies 160;
        // rounded up to 512. Character
        // payload is separate so a long coalesced word is not one cheap token.
        => 1024L + tokenCount * 512L + charCount * 2L;

    internal static long HeadingWorkspaceBytes(int headingCount)
        // Distinct hash set plus immutable array growth/copy and LINQ cursors.
        => 512L + ((long)headingCount + 2L) * 128L;

    private static int CountChangedLines(
        ReadOnlySpan<byte> baseSource,
        ImmutableArray<SourceLine> baseLines,
        ReadOnlySpan<byte> compareSource,
        ImmutableArray<SourceLine> compareLines,
        CancellationToken cancellationToken)
    {
        int prefix = 0;
        while (prefix < baseLines.Length
            && prefix < compareLines.Length
            && LineEquals(baseSource, baseLines[prefix], compareSource, compareLines[prefix]))
        {
            if ((prefix & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            prefix++;
        }
        int suffix = 0;
        while (suffix < baseLines.Length - prefix
            && suffix < compareLines.Length - prefix
            && LineEquals(baseSource, baseLines[baseLines.Length - suffix - 1],
                compareSource, compareLines[compareLines.Length - suffix - 1]))
        {
            if ((suffix & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            suffix++;
        }
        return baseLines.Length + compareLines.Length - 2 * (prefix + suffix);
    }

    private static int CountContextGroups(IReadOnlyList<RevisionDiffHunk> hunks, int contextLineCount)
    {
        int count = 0;
        for (int index = 0; index < hunks.Count; index++)
        {
            RevisionDiffHunk hunk = hunks[index];
            if (hunk.Kind != RevisionDiffKind.Equal)
            {
                continue;
            }
            int leading = index > 0 && hunks[index - 1].Kind != RevisionDiffKind.Equal
                ? Math.Min(contextLineCount, hunk.BaseLineCount)
                : 0;
            int trailing = index + 1 < hunks.Count && hunks[index + 1].Kind != RevisionDiffKind.Equal
                ? Math.Min(contextLineCount, hunk.BaseLineCount - leading)
                : 0;
            count += (leading > 0 ? 1 : 0) + (trailing > 0 ? 1 : 0)
                + (hunk.BaseLineCount > leading + trailing ? 1 : 0);
        }
        return count;
    }
}
