using System.Collections.Immutable;
using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
    private static async Task<(RevisionSourceDiffEngine Engine, RevisionComparePlanBundle Bundle)> SetupAsync(
        byte[] baseline,
        byte[] compare,
        RevisionCompareBudgets? budgets = null,
        int contextLineCount = 3,
        bool headingNavigation = false,
        IRevisionMarkdownStructureProvider? structureProvider = null)
    {
        RevisionComparePackage basePackage = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, baseline);
        RevisionComparePackage comparePackage = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, compare);
        var reader = new FixedReader(basePackage, comparePackage);
        RevisionComparePlanRequest request = new(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: 12),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                contextLineCount,
                headingNavigation,
                ["title"]),
            budgets ?? Budgets(),
            "diff:7:11:12",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        return (
            new RevisionSourceDiffEngine(
                new RevisionComparePlanVerifier(reader),
                new RevisionMarkdownStructureAuthority(
                    structureProvider is null ? [] : [structureProvider])),
            planned.Bundle!);
    }

    private static RevisionMarkdownStructureSnapshot Structure(
        byte[] source,
        params (int Level, int LineIndex, RevisionByteRange Range)[] headings)
    {
        string sourceDigest = RevisionCompareCanonical.Sha256(source);
        var request = new RevisionMarkdownStructureRequest(sourceDigest, [.. source]);
        return RevisionMarkdownStructureSnapshotSeal.Create(
            request,
            "canonical-markdown-test-v1",
            headings.Select(heading => new RevisionMarkdownHeadingNode(
                heading.Level,
                heading.LineIndex,
                heading.Range,
                RevisionCompareCanonical.Sha256(source.AsSpan(heading.Range.Offset, heading.Range.Length)))));
    }

    private static RevisionByteRange LineRange(byte[] source, int startLine, int lineCount)
    {
        int line = 0;
        int start = 0;
        for (int index = 0; index < source.Length && line < startLine; index++)
        {
            if (source[index] == (byte)'\n')
            {
                line++;
                start = index + 1;
            }
        }
        int end = start;
        for (int index = start; index < source.Length && line < startLine + lineCount; index++)
        {
            end = index + 1;
            if (source[index] == (byte)'\n')
            {
                line++;
            }
        }
        return new RevisionByteRange(start, end - start);
    }

    private static RevisionCompareBudgets Budgets()
        => new(2_000_000, 110_000, 100_000, 8 * 1024 * 1024, 64 * 1024 * 1024, 1_000, 64, 10_000);

    private static RevisionSourceDiffResult Reseal(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult source,
        ImmutableArray<RevisionDiffChunk> chunks,
        ImmutableArray<RevisionDiffHeading>? baseHeadings = null,
        ImmutableArray<RevisionDiffHeading>? compareHeadings = null,
        ImmutableArray<RevisionDiffContextGroup>? contextGroups = null)
    {
        ImmutableArray<RevisionDiffHeading> resolvedBaseHeadings = baseHeadings ?? source.BaseHeadings;
        ImmutableArray<RevisionDiffHeading> resolvedCompareHeadings = compareHeadings ?? source.CompareHeadings;
        ImmutableArray<RevisionDiffContextGroup> resolvedContextGroups = contextGroups ?? source.ContextGroups;
        long estimatedOutput = chunks.Sum(static chunk => chunk.Hunks.Length) * 192L
            + chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + (resolvedBaseHeadings.Length + resolvedCompareHeadings.Length) * 96L
            + resolvedContextGroups.Length * 128L
            + ((long)source.BaseLines.Length + source.CompareLines.Length) * 48L;
        RevisionSourceDiffReceipt receipt = RevisionSourceDiffEngine.CreateReceipt(
            bundle,
            source.Status,
            source.Receipt.ReasonCode,
            source.Receipt.StructureParserVersion,
            source.Receipt.BaseStructureDigest,
            source.Receipt.CompareStructureDigest,
            source.BaseLines,
            source.CompareLines,
            resolvedBaseHeadings,
            resolvedCompareHeadings,
            resolvedContextGroups,
            source.Receipt.EstimatedMemoryBytes,
            estimatedOutput,
            source.Receipt.TokenCount,
            chunks);
        return source with
        {
            Chunks = chunks,
            BaseHeadings = resolvedBaseHeadings,
            CompareHeadings = resolvedCompareHeadings,
            ContextGroups = resolvedContextGroups,
            Receipt = receipt,
            AttemptReceipt = RevisionSourceDiffEngine.CreateAttemptReceipt(
                receipt,
                source.AttemptReceipt.ElapsedMilliseconds)
        };
    }

    private static byte[] Apply(
        RevisionSourceDiffResult result,
        byte[] baseline,
        byte[] compare,
        bool forward)
    {
        var output = new List<byte>();
        foreach (RevisionDiffHunk hunk in result.Chunks.SelectMany(static chunk => chunk.Hunks))
        {
            if (forward)
            {
                if (hunk.Kind == RevisionDiffKind.Equal)
                {
                    output.AddRange(baseline.AsSpan(hunk.Base.Offset, hunk.Base.Length).ToArray());
                }
                else if (hunk.Kind is RevisionDiffKind.Insert or RevisionDiffKind.Replace)
                {
                    output.AddRange(compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray());
                }
            }
            else if (hunk.Kind == RevisionDiffKind.Equal)
            {
                output.AddRange(compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray());
            }
            else if (hunk.Kind is RevisionDiffKind.Delete or RevisionDiffKind.Replace)
            {
                output.AddRange(baseline.AsSpan(hunk.Base.Offset, hunk.Base.Length).ToArray());
            }
        }
        return [.. output];
    }

    private static byte[] RandomSource(Random random)
    {
        string[] fragments =
        [
            "alpha",
            "中文",
            "مرحبا",
            "emoji 👩‍💻",
            "cafe\u0301",
            "https://example.test/a/very/long/path?q=1",
            "| a | b |",
            "$x^2$",
            "  trailing  "
        ];
        string[] terminators = ["\n", "\r\n", "\r"];
        var source = new StringBuilder();
        int lineCount = random.Next(0, 40);
        for (int index = 0; index < lineCount; index++)
        {
            source.Append(fragments[random.Next(fragments.Length)]);
            if (index + 1 < lineCount || random.Next(2) == 0)
            {
                source.Append(terminators[random.Next(terminators.Length)]);
            }
        }
        return Encoding.UTF8.GetBytes(source.ToString());
    }

    private static RevisionComparePackage Package(
        RevisionCompareSourceKind kind,
        long revisionId,
        int revisionNo,
        byte[] markdown)
        => RevisionComparePackageSeal.Create(
            7,
            kind,
            $"revision:{revisionId}",
            revisionId,
            revisionNo,
            null,
            null,
            markdown,
            [RevisionCompareMetadataRegistry.String("title", "Title")],
            [
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private static RevisionComparePackage DraftPackage(
        string documentEpoch,
        long serverRevision,
        string markdown)
        => RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.CurrentDraft,
            $"draft:5:draft-key:{serverRevision}:{documentEpoch}",
            null,
            null,
            serverRevision,
            documentEpoch,
            Encoding.UTF8.GetBytes(markdown),
            [RevisionCompareMetadataRegistry.String("title", "Title")],
            [
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private sealed class FixedReader(
        RevisionComparePackage baseline,
        RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(RevisionComparePackageReadResult.Available(
                selector.RevisionId == baseline.RevisionId ? baseline : compare));
        }
    }

    private sealed class MutableReader(
        RevisionComparePackage baseline,
        RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public RevisionComparePackage Baseline { get; set; } = baseline;

        public RevisionComparePackage Compare { get; set; } = compare;

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(RevisionComparePackageReadResult.Available(
                selector.Kind == RevisionCompareSourceKind.CurrentDraft ? Baseline : Compare));
        }
    }

    private sealed class FixedStructureProvider(
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);

        public Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable());
        }
    }

    private sealed class LateStructureProvider(
        TimeSpan delay,
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);

        public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            await Task.Delay(delay);
            return _snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable();
        }
    }

    private sealed class CoordinatedStructureProvider(
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);
        private int _readCount;

        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref _readCount) == 1)
            {
                Started.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return _snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable();
        }
    }
}
