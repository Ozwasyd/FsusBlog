using System.Collections.Immutable;
using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
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
    public async Task Verify_RejectsOverflowingLineCoordinatesWithoutThrowing()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\n");
        byte[] compare = Encoding.UTF8.GetBytes("two\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffLine line = Assert.Single(result.BaseLines);
        RevisionSourceDiffResult tampered = result with
        {
            BaseLines = [line with
            {
                Content = new RevisionByteRange(0, int.MaxValue),
                Terminator = new RevisionByteRange(int.MaxValue, 1)
            }]
        };

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task Verify_RejectsResealedWordKindAndOrderingTamper()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("alpha old middle bad omega\n");
        byte[] compare = Encoding.UTF8.GetBytes("alpha new middle good omega\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffChunk chunk = Assert.Single(result.Chunks);
        RevisionDiffHunk hunk = Assert.Single(chunk.Hunks, static candidate => candidate.Kind == RevisionDiffKind.Replace);
        RevisionDiffWordEdit first = hunk.WordEdits[0] with
        {
            Kind = RevisionDiffKind.Insert
        };
        RevisionDiffHunk tamperedHunk = hunk with
        {
            WordEdits = [hunk.WordEdits[1], first]
        };
        ImmutableArray<RevisionDiffHunk> hunks = [.. chunk.Hunks.Select(item => item == hunk ? tamperedHunk : item)];
        RevisionDiffChunk tamperedChunk = chunk with
        {
            Hunks = hunks,
            ContentDigest = RevisionSourceDiffEngine.CreateChunkDigest(chunk.Index, hunks)
        };
        RevisionSourceDiffResult tampered = Reseal(plan, result, [tamperedChunk]);

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task ComputeAsync_SingleByteReplacementAppliesForwardAndReverse()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("a");
        byte[] compare = Encoding.UTF8.GetBytes("b");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(new RevisionByteRange(0, 1), replacement.Base);
        Assert.Equal(new RevisionByteRange(0, 1), replacement.Compare);
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_RepresentativeAndSeededRandomCorpusAppliesForwardAndReverse()
    {
        var corpus = new List<(byte[] Base, byte[] Compare)>
        {
            ([], []),
            (Encoding.UTF8.GetBytes("same\n"), Encoding.UTF8.GetBytes("same\n")),
            (Encoding.UTF8.GetBytes("a"), Encoding.UTF8.GetBytes("b")),
            (Encoding.UTF8.GetBytes("delete\r\n"), []),
            ([], Encoding.UTF8.GetBytes("insert\r")),
            (
                [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("CJK 中文\r\nemoji 👩‍💻  \n")],
                Encoding.UTF8.GetBytes("CJK 漢字\nemoji 👩‍🔬\r")),
            (
                Encoding.UTF8.GetBytes("```mermaid\ngraph TD; A-->B\n```\n$x^2$ [link](https://a.test/long/path?q=1)\n"),
                Encoding.UTF8.GetBytes("```mermaid\ngraph TD; A-->C\n```\n$x^3$ [link](https://b.test/long/path?q=2)\n"))
        };
        var random = new Random(2270);
        for (int sample = 0; sample < 32; sample++)
        {
            corpus.Add((RandomSource(random), RandomSource(random)));
        }

        foreach ((byte[] baseline, byte[] compare) in corpus)
        {
            (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
            RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

            Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
            Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
            Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
            Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
        }
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
                MaxOutputBytes = 400
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
}
