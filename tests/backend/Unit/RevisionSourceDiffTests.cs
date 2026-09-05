using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_PreservesBomLineEndingsWhitespaceAndFinalNewlineAsBytes()
    {
        byte[] baseline = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("alpha\r\nbeta  \n")];
        byte[] compare = Encoding.UTF8.GetBytes("alpha\nbeta\r");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
        Assert.Equal(baseline.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Base.Length));
        Assert.Equal(compare.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Compare.Length));
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(
            [RevisionLineTerminator.CarriageReturnLineFeed, RevisionLineTerminator.LineFeed],
            result.BaseLines.Select(static line => line.TerminatorKind));
        Assert.Equal(
            [RevisionLineTerminator.LineFeed, RevisionLineTerminator.CarriageReturn],
            result.CompareLines.Select(static line => line.TerminatorKind));
    }

    [Fact]
    public async Task ComputeAsync_IdenticalSourceProducesOneExactEqualHunk()
    {
        byte[] source = Encoding.UTF8.GetBytes("same\r\ncontent without final newline");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(source, source);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk hunk = Assert.Single(Assert.Single(result.Chunks).Hunks);
        Assert.Equal(RevisionDiffKind.Equal, hunk.Kind);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Base);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Compare);
        Assert.Empty(hunk.WordEdits);
    }

    [Fact]
    public async Task ComputeAsync_WordRefinementUsesExactUnicodeGraphemeByteRanges()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("前言 emoji 👩‍💻 cafe\u0301 مرحبا https://a.test/路径\n");
        byte[] compare = Encoding.UTF8.GetBytes("前言 emoji 👩‍🔬 café مرحبتين https://b.test/路径\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        RevisionDiffWordEdit edit = Assert.Single(replacement.WordEdits);
        Assert.True(edit.Base.Offset >= 0 && edit.Base.End <= baseline.Length);
        Assert.True(edit.Compare.Offset >= 0 && edit.Compare.End <= compare.Length);
        Assert.NotEqual(
            baseline.AsSpan(edit.Base.Offset, edit.Base.Length).ToArray(),
            compare.AsSpan(edit.Compare.Offset, edit.Compare.Length).ToArray());
        Assert.True(result.Receipt.TokenCount > 0);
    }

    [Fact]
    public async Task ComputeAsync_HeadingNavigationIsFenceAwareAndBindsSectionChanges()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("# Real\nold\n```md\n# Not heading\n```\nSection\n---\ntail\n");
        byte[] compare = Encoding.UTF8.GetBytes("# Real\nnew\n```md\n# Still not heading\n```\nSection\n---\ntail\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(2, result.BaseHeadings.Length);
        Assert.Equal([1, 2], result.BaseHeadings.Select(static heading => heading.Level));
        RevisionDiffHunk changed = result.Chunks.SelectMany(static chunk => chunk.Hunks)
            .First(static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.NotEmpty(changed.HeadingIdentities);
        Assert.DoesNotContain(result.BaseHeadings, heading => heading.LineIndex == 3);
    }

    [Fact]
    public async Task ComputeAsync_ChunksClosedHunksAndRemainsDeterministic()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("a\nkeep-1\nb\nkeep-2\nc\n");
        byte[] compare = Encoding.UTF8.GetBytes("x\nkeep-1\ny\nkeep-2\nz\n");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxHunksPerChunk = 1,
            MaxChunks = 16
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult first = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionSourceDiffResult second = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(first.Chunks.Length > 1);
        Assert.All(first.Chunks, static chunk => Assert.Single(chunk.Hunks));
        Assert.Equal(first.Receipt.ContentDigest, second.Receipt.ContentDigest);
        Assert.Equal(first.Chunks.Select(static chunk => chunk.ContentDigest), second.Chunks.Select(static chunk => chunk.ContentDigest));
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, first));
    }

    [Fact]
    public async Task ComputeAsync_HandlesOneHundredThousandLinesWithinLinearAdmissionEnvelope()
    {
        string[] lines = Enumerable.Range(0, 100_000).Select(static index => $"line-{index:D6}\n").ToArray();
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(lines));
        lines[50_000] = "line-changed\n";
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(lines));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxSourceBytes = 2_000_000,
            MaxLineCount = 110_000,
            MaxMemoryBytes = 64 * 1024 * 1024,
            MaxTokenCount = 10_000,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_FailsClosedForTokenBudgetAndCancellation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("abcdefghij\n");
        byte[] compare = Encoding.UTF8.GetBytes("0123456789\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 3
            });

        RevisionSourceDiffResult budget = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        RevisionSourceDiffResult cancellation = await engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancelled.Token);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, budget.Status);
        Assert.Equal("revision_diff_token_budget_exceeded", budget.Receipt.ReasonCode);
        Assert.Equal(RevisionComparePlanStatus.Cancelled, cancellation.Status);
        Assert.Empty(cancellation.Chunks);
    }

    [Fact]
    public async Task Verify_RejectsMutatedClosedRange()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\n");
        byte[] compare = Encoding.UTF8.GetBytes("two\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffChunk chunk = Assert.Single(result.Chunks);
        RevisionDiffHunk hunk = Assert.Single(chunk.Hunks);
        RevisionSourceDiffResult tampered = result with
        {
            Chunks = [chunk with { Hunks = [hunk with { Base = new RevisionByteRange(1, hunk.Base.Length) }] }]
        };

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task ComputeAsync_TreatsStructuredMarkdownAsRawSourceWithoutHtmlOrRegexSubstitution()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x^2$\n![alt](a.png) [link](https://a.test/x?q=1)\n");
        byte[] compare = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 3 |\n\n```mermaid\ngraph TD; A-->C\n```\n\n$x^3$\n![alt](b.png) [link](https://a.test/x?q=2)\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        byte[] reconstructedCompare = result.Chunks
            .SelectMany(static chunk => chunk.Hunks)
            .SelectMany(hunk => compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray())
            .ToArray();
        Assert.Equal(compare, reconstructedCompare);
        Assert.Empty(result.CompareHeadings);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Theory]
    [InlineData("", "insert\n", RevisionDiffKind.Insert)]
    [InlineData("delete\n", "", RevisionDiffKind.Delete)]
    [InlineData("", "", RevisionDiffKind.Equal)]
    public async Task ComputeAsync_ClosesEmptyAndOneSidedInputs(
        string baselineText,
        string compareText,
        RevisionDiffKind expected)
    {
        byte[] baseline = Encoding.UTF8.GetBytes(baselineText);
        byte[] compare = Encoding.UTF8.GetBytes(compareText);
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        RevisionDiffHunk[] hunks = [.. result.Chunks.SelectMany(static chunk => chunk.Hunks)];
        if (expected == RevisionDiffKind.Equal && baseline.Length == 0)
        {
            Assert.Empty(hunks);
        }
        else
        {
            Assert.Equal(expected, Assert.Single(hunks).Kind);
        }
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_InvalidUtf8SkipsOnlyWordRefinement()
    {
        byte[] baseline = [0x66, 0x6f, 0x80, 0x0a];
        byte[] compare = [0x66, 0x6f, 0x81, 0x0a];
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Empty(replacement.WordEdits);
        Assert.Equal(baseline.Length, replacement.Base.Length);
        Assert.Equal(compare.Length, replacement.Compare.Length);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public void EngineSource_HasNoHtmlRegexDraftMutationOrFragmentInsertionAuthority()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "core",
            "Services",
            "Articles",
            "RevisionSourceDiff.cs"));

        Assert.DoesNotContain("Regex", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Html", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CurrentDraft", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Fragment", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MarkdownContent", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ComputeAsync_RejectsExpiredPlanAndBoundedOutput()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\nkeep\ntwo\n");
        byte[] compare = Encoding.UTF8.GetBytes("first\nkeep\nsecond\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxOutputBytes = 1
            });

        RevisionSourceDiffResult expired = await engine.ComputeAsync(
            plan,
            plan.Plan.ExpiresAtUtc.AddTicks(1));
        RevisionSourceDiffResult bounded = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Stale, expired.Status);
        Assert.Equal("revision_compare_plan_expired", expired.Receipt.ReasonCode);
        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, bounded.Status);
        Assert.Equal("revision_diff_output_budget_exceeded", bounded.Receipt.ReasonCode);
        Assert.Empty(bounded.Chunks);
    }

    private static async Task<(RevisionSourceDiffEngine Engine, RevisionComparePlanBundle Bundle)> SetupAsync(
        byte[] baseline,
        byte[] compare,
        RevisionCompareBudgets? budgets = null)
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
                3,
                true,
                ["title"]),
            budgets ?? Budgets(),
            "diff:7:11:12",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        return (new RevisionSourceDiffEngine(new RevisionComparePlanVerifier(reader)), planned.Bundle!);
    }

    private static RevisionCompareBudgets Budgets()
        => new(2_000_000, 110_000, 100_000, 8 * 1024 * 1024, 64 * 1024 * 1024, 1_000, 64, 10_000);

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
}
