using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AedsJsonOutputBudgetTests
{
    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData(long.MaxValue)]
    [InlineData(long.MinValue)]
    public void MeasureOutput_CountsTheCanonicalMetadataDecimalString(long number)
    {
        ArticleRevisionMetadataDiffValue value = ArticleRevisionMetadataDiffValue.From(
            new RevisionMetadataDiffValue(RevisionMetadataDiffValueKind.Integer, Number: number));
        int actual = JsonSerializer.SerializeToUtf8Bytes(value, s_options).Length;
        Assert.Equal(new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, actual),
            AedsJsonResults.MeasureOutput(value, actual));
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded,
            AedsJsonResults.MeasureOutput(value, actual - 1).Status);
    }

    [Fact]
    public void MemoryWithinBudget_UsesTheSharedHeaderAndExactPayloadCountWithoutOverflow()
    {
        var wire = new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, 1024);
        long exact = 17 + AedsJsonResults.SerializationMemoryReserveBytes + 4L * wire.ByteCount + AedsFrameHeader.Size;
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire, 17, exact - 1));
        Assert.True(AedsJsonResults.MemoryWithinBudget(wire, 17, exact));
        Assert.True(AedsJsonResults.MemoryWithinBudget(wire, 17, exact + 1));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire with
        {
            ByteCount = long.MaxValue
        }, 0, long.MaxValue));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire, long.MaxValue, long.MaxValue));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire, -1, exact));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire, 0, 0));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire with
        {
            ByteCount = 0
        }, 0, exact));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire with
        {
            ByteCount = -1
        }, 0, exact));
        Assert.False(AedsJsonResults.MemoryWithinBudget(wire with
        {
            Status = AedsJsonOutputBudgetStatus.InvalidBudget
        }, 0, exact));
    }

    [Theory]
    [InlineData("plain")]
    [InlineData("中文 👩‍💻 <tag> \"quoted\"\n")]
    public void MeasureOutput_UsesExactCanonicalBytesAtAndAroundTheLimit(string text)
    {
        var value = new
        {
            Text = text,
            Range = new RevisionByteRange(17, 4)
        };
        int actual = JsonSerializer.SerializeToUtf8Bytes(value, s_options).Length;

        AedsJsonOutputBudgetResult below = AedsJsonResults.MeasureOutput(value, actual - 1);
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded, below.Status);
        Assert.Equal(0, below.ByteCount);
        foreach (long limit in new[] { actual, actual + 1L, long.MaxValue })
        {
            AedsJsonOutputBudgetResult accepted = AedsJsonResults.MeasureOutput(value, limit);
            Assert.Equal(AedsJsonOutputBudgetStatus.Accepted, accepted.Status);
            Assert.Equal(actual, accepted.ByteCount);
        }
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    [InlineData(long.MinValue)]
    public void MeasureOutput_RejectsInvalidBudgetsBeforeReadingTheValue(long limit)
    {
        var value = new UnreadableValue();
        AedsJsonOutputBudgetResult result = AedsJsonResults.MeasureOutput(value, limit);
        Assert.Equal(AedsJsonOutputBudgetStatus.InvalidBudget, result.Status);
        Assert.Equal(0, result.ByteCount);
    }

    [Fact]
    public void MeasureOutput_PropagatesCancellationBeforeAndDuringSerialization()
    {
        using var before = new CancellationTokenSource();
        before.Cancel();
        Assert.Throws<OperationCanceledException>(() => AedsJsonResults.MeasureOutput(
            new UnreadableValue(), 100, before.Token));

        using var during = new CancellationTokenSource();
        Assert.Throws<OperationCanceledException>(() => AedsJsonResults.MeasureOutput(
            CancelledNumbers(during), long.MaxValue, during.Token));
    }

    [Fact]
    public void MeasureOutput_RefusesLargeEscapedAtomicValueWithoutGrowingTheBuffer()
    {
        string value = new('<', 1_000_000);
        Assert.Equal(AedsJsonOutputBudgetStatus.Accepted, AedsJsonResults.MeasureOutput("warm", 100).Status);
        long before = GC.GetAllocatedBytesForCurrentThread();
        AedsJsonOutputBudgetResult result = AedsJsonResults.MeasureOutput(value, long.MaxValue);
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(AedsJsonOutputBudgetStatus.SerializationBufferExceeded, result.Status);
        Assert.Equal(0, result.ByteCount);
        Assert.True(allocated <= AedsJsonResults.SerializationMemoryReserveBytes, $"allocated {allocated}");
    }

    [Fact]
    public void MeasureOutput_RefusesLargeUtf8JsonElementAtomBeforeEscapeScratchAllocation()
    {
        using JsonDocument document = JsonDocument.Parse("\"" + new string('<', 8_000) + "\"");
        using JsonDocument warm = JsonDocument.Parse("\"warm\"");
        Assert.Equal(AedsJsonOutputBudgetStatus.Accepted, AedsJsonResults.MeasureOutput(warm.RootElement, 100).Status);
        long before = GC.GetAllocatedBytesForCurrentThread();
        AedsJsonOutputBudgetResult result = AedsJsonResults.MeasureOutput(document.RootElement, long.MaxValue);
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(AedsJsonOutputBudgetStatus.SerializationBufferExceeded, result.Status);
        Assert.Equal(0, result.ByteCount);
        Assert.True(allocated <= AedsJsonResults.SerializationMemoryReserveBytes, $"allocated {allocated}");
    }

    [Theory]
    [InlineData("中文 👩‍💻 <tag> \"quoted\"\n")]
    [InlineData("<>&+\\")]
    public void MeasureOutput_PreservesCanonicalUtf8JsonElementBytes(string text)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            Text = text
        }, s_options));
        int actual = JsonSerializer.SerializeToUtf8Bytes(document.RootElement, s_options).Length;
        Assert.Equal(new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, actual),
            AedsJsonResults.MeasureOutput(document.RootElement, actual));
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded,
            AedsJsonResults.MeasureOutput(document.RootElement, actual - 1).Status);
    }

    [Theory]
    [InlineData(2730, false, false)]
    [InlineData(2730, true, true)]
    [InlineData(910, false, true)]
    [InlineData(910, true, true)]
    public void MeasureOutput_BoundsEscapedAtomicResourcesUsingCanonicalBytesWithinReservedMemory(
        int inputLength, bool utf8, bool accepted)
    {
        // Passing scalar admission does not waive the writer's actual span
        // request. Its UTF-16 transcoding reservation can still refuse an atom.
        string text = new('<', inputLength);
        using JsonDocument document = JsonDocument.Parse("\"" + text + "\"");
        using JsonDocument warm = JsonDocument.Parse("\"warm\"");
        object value = utf8 ? document.RootElement : text;
        object warmValue = utf8 ? warm.RootElement : "warm";
        int actual = JsonSerializer.SerializeToUtf8Bytes(value, s_options).Length;
        Assert.Equal(AedsJsonOutputBudgetStatus.Accepted, AedsJsonResults.MeasureOutput(warmValue, 100).Status);
        long before = GC.GetAllocatedBytesForCurrentThread();
        AedsJsonOutputBudgetResult result = AedsJsonResults.MeasureOutput(value, actual);
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(accepted
            ? new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, actual)
            : new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.SerializationBufferExceeded, 0), result);
        Assert.True(allocated <= AedsJsonResults.SerializationMemoryReserveBytes, $"allocated {allocated}");
    }

    [Theory]
    [InlineData(170, false)]
    [InlineData(1000, false)]
    [InlineData(170, true)]
    [InlineData(1000, true)]
    public async Task MeasureOutput_CountsCompleteActualCompareDtoAndRefusesTheOldLogicalEstimate(int lineCount, bool changed)
    {
        (ArticleRevisionCompareResponse response, RevisionSourceDiffResult diff) = await CompareAsync(lineCount, changed);
        Assert.Equal(changed, diff.Chunks.SelectMany(static chunk => chunk.Hunks)
            .Any(static hunk => hunk.Kind != RevisionDiffKind.Equal));
        int actual = JsonSerializer.SerializeToUtf8Bytes(response, s_options).Length;
        Assert.True(actual > diff.Receipt.EstimatedOutputBytes + 4096);
        AedsJsonOutputBudgetResult oldBudget = AedsJsonResults.MeasureOutput(
            response, diff.Receipt.EstimatedOutputBytes + 4096);
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded, oldBudget.Status);
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded,
            AedsJsonResults.MeasureOutput(response, actual - 1).Status);
        Assert.Equal(new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, actual),
            AedsJsonResults.MeasureOutput(response, actual));
        Assert.Equal(new AedsJsonOutputBudgetResult(AedsJsonOutputBudgetStatus.Accepted, actual),
            AedsJsonResults.MeasureOutput(response, actual + 1L));
    }

    [Fact]
    public async Task MeasureOutput_PreservesLargeCorePositiveButRefusesItsSixteenMiBWirePayload()
    {
        (ArticleRevisionCompareResponse response, RevisionSourceDiffResult diff) = await CompareAsync(100_001);
        Assert.True(diff.IsSuccess, diff.Receipt.ReasonCode);
        Assert.True(diff.Receipt.EstimatedOutputBytes <= 16 * 1024 * 1024);
        AedsJsonOutputBudgetResult result = AedsJsonResults.MeasureOutput(response, 16 * 1024 * 1024);
        Assert.Equal(AedsJsonOutputBudgetStatus.OutputBudgetExceeded, result.Status);
        Assert.Equal(0, result.ByteCount);
    }

    private static async Task<(ArticleRevisionCompareResponse Response, RevisionSourceDiffResult Diff)> CompareAsync(int lines, bool changed = false)
    {
        byte[] source = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("a\n", lines)));
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, source);
        byte[] comparedSource = changed
            ? Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, lines).Select(static index => index % 10 == 0 ? "b\n" : "a\n")))
            : source;
        RevisionComparePackage compare = Package(RevisionCompareSourceKind.CurrentRevision, 12, comparedSource);
        var reader = new FixedReader(baseline, compare);
        RevisionCompareBudgets budgets = new(2_000_000, 110_000, 100_000,
            16 * 1024 * 1024, 64 * 1024 * 1024, 1_000, 64, 20_000);
        var request = new RevisionComparePlanRequest(7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new(RevisionCompareSourceKind.CurrentRevision, RevisionId: 12),
            new(RevisionCompareViewMode.Unified, RevisionCompareWordSegmentation.UnicodeTextElementsV1, 3, false, []),
            budgets, "wire-budget", DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        RevisionComparePlanBundle bundle = planned.Bundle!;
        RevisionSourceDiffResult diff = await new RevisionSourceDiffEngine(new RevisionComparePlanVerifier(reader),
                new RevisionMarkdownStructureAuthority([]))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);
        Assert.True(diff.IsSuccess, diff.Receipt.ReasonCode);
        Assert.True(RevisionSourceDiffVerifier.Verify(bundle, diff));
        return (ArticleRevisionCompareResponse.From(ArticleRevisionComparePlanReceipt.From(planned.Receipt), diff, null), diff);
    }

    private static RevisionComparePackage Package(RevisionCompareSourceKind kind, long id, byte[] source)
        => RevisionComparePackageSeal.Create(7, kind, $"revision:{id}", id, (int)id, null, null, source,
            [RevisionCompareMetadataRegistry.String("title", "Title")],
            [RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)]);

    private static IEnumerable<int> CancelledNumbers(CancellationTokenSource cancellation)
    {
        for (int index = 0; index < 10_000; index++)
        {
            if (index == 10)
            {
                cancellation.Cancel();
            }
            yield return index;
        }
    }

    private sealed class UnreadableValue
    {
        public string Value => throw new InvalidOperationException("invalid budgets must not read payload values");
    }

    private sealed class FixedReader(RevisionComparePackage baseline, RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(RevisionCompareReadContext context,
            int articleId, RevisionCompareSourceSelector selector, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : compare));
        }
    }
}
