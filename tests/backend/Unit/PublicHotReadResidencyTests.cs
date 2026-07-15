using System.Collections.Frozen;
using System.Runtime.InteropServices;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadResidencyTests
{
    [Fact]
    public void Accounting_ExposesPayloadIndexObjectAndLohUpperBounds()
    {
        var article = Artifact(100, 50, 25, 1);
        var list = Artifact(200, 75, 30, 1);
        var category = Artifact(300, 80, 35, 1);
        var tag = Artifact(400, 90, 40, 1);
        var html = new PublicHtmlArtifact(new byte[85_000], "text/html", "\"html\"", "public,max-age=60");
        var snapshot = new PublicHotReadSnapshot(
            1,
            new Dictionary<int, PublicBinaryArtifact> { [1] = article }.ToFrozenDictionary(),
            new Dictionary<PublicListKey, PublicBinaryArtifact>
            {
                [new PublicListKey(PublicListKind.Home, 0, 1, 10)] = list
            }.ToFrozenDictionary(),
            category,
            tag,
            new Dictionary<string, PublicHtmlArtifact> { ["/"] = html }.ToFrozenDictionary(StringComparer.Ordinal),
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));

        PublicHotReadResidentBreakdown residency = snapshot.Residency;
        Assert.Equal(1_000, residency.RawAedsBytes);
        Assert.Equal(295, residency.BrotliBytes);
        Assert.Equal(130, residency.GzipBytes);
        Assert.Equal(85_000, residency.HtmlBytes);
        Assert.True(residency.KeyIndexBytes > 0);
        Assert.Equal(5, residency.ArtifactCount);
        Assert.True(residency.ObjectCount >= residency.ArtifactCount);
        Assert.True(residency.ArrayCount >= 13);
        Assert.Equal(1, residency.LohEligibleArrayCount);
        Assert.Equal(85_000, residency.LohEligibleArrayBytes);
        Assert.Equal(
            residency.RawAedsBytes + residency.CompressedBytes + residency.HtmlBytes
                + residency.HtmlTemplateBytes + residency.KeyIndexBytes,
            residency.TotalBytes);
        Assert.Equal(residency.TotalBytes, snapshot.ResidentBytes);
    }

    [Fact]
    public void DynamicBudgets_UseContainerVisibleLimitAndExplicitValuesWin()
    {
        PublicHotReadBudgetLimits dynamicLimits = PublicHotReadStore.ResolveBudgetLimitsForTests(
            new PublicHotReadOptions(),
            1024L * 1024 * 1024);

        Assert.Equal(1024L * 1024 * 1024, dynamicLimits.ContainerMemoryLimitBytes);
        Assert.Equal(128L * 1024 * 1024, dynamicLimits.MaxResidentBytes);
        Assert.Equal(96L * 1024 * 1024, dynamicLimits.MaxRawBytes);
        Assert.Equal(256L * 1024 * 1024, dynamicLimits.MaxSnapshotOverlapBytes);
        Assert.Equal(128 * 1024, dynamicLimits.MaxArtifactObjects);

        PublicHotReadBudgetLimits explicitLimits = PublicHotReadStore.ResolveBudgetLimitsForTests(
            new PublicHotReadOptions
            {
                MaxResidentBytes = 1000,
                MaxRawBytes = 900,
                MaxCompressedBytes = 800,
                MaxHtmlBytes = 700,
                MaxSnapshotOverlapBytes = 1600,
                MaxArticleResidentBytes = 600,
                MaxArtifactObjects = 500
            },
            4096);
        Assert.Equal(1000, explicitLimits.MaxResidentBytes);
        Assert.Equal(900, explicitLimits.MaxRawBytes);
        Assert.Equal(800, explicitLimits.MaxCompressedBytes);
        Assert.Equal(700, explicitLimits.MaxHtmlBytes);
        Assert.Equal(1600, explicitLimits.MaxSnapshotOverlapBytes);
        Assert.Equal(600, explicitLimits.MaxArticleResidentBytes);
        Assert.Equal(500, explicitLimits.MaxArtifactObjects);
    }

    [Fact]
    public void Publish_RejectsCandidateCurrentOverlapAndRetainsActiveSnapshot()
    {
        PublicHotReadSnapshot first = Snapshot(1, 1, Artifact(256, 0, 0, 1));
        PublicHotReadSnapshot second = Snapshot(2, 2, Artifact(384, 0, 0, 2));
        long overlap = first.ResidentBytes + second.ResidentBytes;
        var store = new PublicHotReadStore(options: Options.Create(new PublicHotReadOptions
        {
            MaxResidentBytes = 1_000_000,
            MaxRawBytes = 1_000_000,
            MaxCompressedBytes = 1_000_000,
            MaxHtmlBytes = 1_000_000,
            MaxSnapshotOverlapBytes = overlap - 1,
            MaxArtifactObjects = 10_000
        }));
        store.Publish(first);

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => store.Publish(second));

        Assert.Contains("snapshot-overlap", error.Message, StringComparison.Ordinal);
        Assert.Same(first, store.Current);
        PublicHotReadRuntimeSnapshot runtime = store.CreateRuntimeSnapshot();
        Assert.True(runtime.ResidentByteBudgetExceeded);
        Assert.Equal(overlap, runtime.SnapshotOverlapBytes);
        Assert.Contains(runtime.BudgetViolations, static item => item.StartsWith("snapshot-overlap:", StringComparison.Ordinal));
        Assert.Equal("validate-rejected", runtime.LifecycleStage);
    }

    [Fact]
    public void Publish_CountsEveryLiveRetiringSnapshotBeforeAcceptingNextVersion()
    {
        PublicHotReadSnapshot first = Snapshot(1, 1, Artifact(256, 0, 0, 1));
        PublicHotReadSnapshot second = Snapshot(2, 2, Artifact(256, 0, 0, 2));
        PublicHotReadSnapshot third = Snapshot(3, 3, Artifact(256, 0, 0, 3));
        long allThree = first.ResidentBytes + second.ResidentBytes + third.ResidentBytes;
        var store = new PublicHotReadStore(options: Options.Create(new PublicHotReadOptions
        {
            MaxResidentBytes = 1_000_000,
            MaxRawBytes = 1_000_000,
            MaxCompressedBytes = 1_000_000,
            MaxHtmlBytes = 1_000_000,
            MaxSnapshotOverlapBytes = allThree - 1,
            MaxArtifactObjects = 10_000
        }));
        store.Publish(first);
        store.Publish(second);

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => store.Publish(third));

        Assert.Contains($"snapshot-overlap:{allThree}", error.Message, StringComparison.Ordinal);
        Assert.Same(second, store.Current);
        Assert.Equal(first.ResidentBytes, store.CreateRuntimeSnapshot().RetiringSnapshotBytes);
        GC.KeepAlive(first);
    }

    [Fact]
    public void Publish_AggregatesEveryBudgetViolationBeforeFailClosed()
    {
        var store = new PublicHotReadStore(options: Options.Create(new PublicHotReadOptions
        {
            MaxResidentBytes = 1,
            MaxRawBytes = 1,
            MaxCompressedBytes = 1,
            MaxHtmlBytes = 1,
            MaxSnapshotOverlapBytes = 1,
            MaxArticleResidentBytes = 1,
            MaxArtifactObjects = 1
        }));
        var snapshot = new PublicHotReadSnapshot(
            1,
            new Dictionary<int, PublicBinaryArtifact> { [1] = Artifact(100, 50, 25, 1) }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            new Dictionary<string, PublicHtmlArtifact> { ["/"] = Html(new string('x', 100)) }.ToFrozenDictionary(StringComparer.Ordinal),
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => store.Publish(snapshot));

        foreach (string violation in new[] { "resident:", "raw:", "compressed:", "html:", "snapshot-overlap:", "objects:" })
        {
            Assert.Contains(violation, error.Message, StringComparison.Ordinal);
        }
        Assert.Same(PublicHotReadSnapshot.Empty, store.Current);
        Assert.False(store.IsReady);
    }

    [Fact]
    public void Lifecycle_RecordsBuildValidateAdmitPublishAndRetireWhileNMinusOneRemainsReadable()
    {
        PublicHotReadSnapshot first = Snapshot(1, 1, Artifact(128, 0, 0, 1));
        PublicHotReadSnapshot second = Snapshot(2, 2, Artifact(128, 0, 0, 2));
        var store = new PublicHotReadStore();
        store.BeginBuild("initial");
        store.Publish(first);
        store.BeginBuild("delta");
        store.Publish(second);

        PublicHotReadRuntimeSnapshot runtime = store.CreateRuntimeSnapshot();
        foreach (string stage in new[] { "build", "validate", "admit", "publish", "retire" })
        {
            Assert.Contains(stage, runtime.LifecycleHistory);
        }
        Assert.Equal("retire", runtime.LifecycleStage);
        Assert.True(first.TryGetArticle(1, out PublicBinaryArtifact previous));
        Assert.Equal("\"raw-1\"", previous.ETag);
        Assert.True(second.TryGetArticle(2, out PublicBinaryArtifact active));
        Assert.Equal("\"raw-2\"", active.ETag);
    }

    [Fact]
    public void ArticleAdmission_CombinesPopularAndRecentThenEvictsByResidentBytes()
    {
        Assert.Equal(
            [10, 20, 11, 21, 12],
            PublicHotArtifactProjector.MergeAdmissionSegments([10, 11, 12], [20, 21, 10], 5));
        var candidates = new Dictionary<int, PublicBinaryArtifact>
        {
            [1] = Artifact(100, 0, 0, 1),
            [2] = Artifact(100, 0, 0, 1),
            [3] = Artifact(100, 0, 0, 1)
        };
        var options = new PublicHotReadOptions
        {
            MaxResidentBytes = 10_000,
            MaxRawBytes = 10_000,
            MaxArticleResidentBytes = 700,
            MaxArticleFrames = 3
        };

        Dictionary<int, PublicBinaryArtifact> admitted = PublicHotArtifactProjector.ApplyArticleAdmission(
            candidates,
            [2, 1, 3],
            options);

        Assert.Equal([2, 1], admitted.Keys);
    }

    [Fact]
    public void CompressionAdmission_RequiresMeasuredClientShareAndSavings()
    {
        var shareOptions = new PublicHotReadOptions
        {
            MinPrecompressedFrameBytes = 1,
            ExpectedBrotliClientSharePercent = 80,
            ExpectedGzipClientSharePercent = 0,
            MinResidentVariantClientSharePercent = 5
        };
        PublicBinaryArtifact shareArtifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.ArticleDetail,
            Enumerable.Repeat((byte)'a', 4096).ToArray(),
            "public,max-age=60",
            1,
            shareOptions);
        Assert.False(shareArtifact.BrotliFrame.IsEmpty);
        Assert.True(shareArtifact.GzipFrame.IsEmpty);

        var savingsOptions = new PublicHotReadOptions
        {
            MinPrecompressedFrameBytes = 1,
            MinCompressionSavingsPercent = 99,
            ExpectedBrotliClientSharePercent = 100,
            ExpectedGzipClientSharePercent = 100
        };
        byte[] incompressiblePayload = new byte[4096];
        new Random(42).NextBytes(incompressiblePayload);
        PublicBinaryArtifact savingsArtifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.ArticleDetail,
            incompressiblePayload,
            "public,max-age=60",
            1,
            savingsOptions);
        Assert.True(savingsArtifact.BrotliFrame.IsEmpty);
        Assert.True(savingsArtifact.GzipFrame.IsEmpty);
    }

    [Fact]
    public void CompressionSelectionCounters_ExposeObservedClientDistributionWithoutSharedLock()
    {
        var counters = new PublicHotReadCounters();
        counters.VariantSelected(string.Empty);
        counters.VariantSelected("br");
        counters.VariantSelected("br");
        counters.VariantSelected("gzip");

        PublicHotReadCounterSnapshot snapshot = counters.Snapshot();

        Assert.Equal(1, snapshot.IdentityVariant);
        Assert.Equal(2, snapshot.BrotliVariant);
        Assert.Equal(1, snapshot.GzipVariant);
    }

    [Fact]
    public void HtmlOverlay_CompactsAtBoundAndPreservesVisibleArtifacts()
    {
        FrozenDictionary<string, PublicHtmlArtifact> html = Enumerable.Range(0, 64)
            .ToDictionary(index => $"/{index}", index => Html($"base-{index}"), StringComparer.Ordinal)
            .ToFrozenDictionary(StringComparer.Ordinal);
        var snapshot = new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));
        for (int index = 0; index < 31; index++)
        {
            snapshot = snapshot.WithHtml($"/{index}", Html($"overlay-{index}"));
        }
        Assert.Equal(31, snapshot.HtmlOverlayEntryCount);
        Assert.True(snapshot.Residency.OverlayBytes > 0);

        snapshot = snapshot.WithHtml("/31", Html("overlay-31"));

        Assert.Equal(0, snapshot.HtmlOverlayEntryCount);
        Assert.Equal(0, snapshot.HtmlRemovedEntryCount);
        Assert.Equal(64, snapshot.HtmlFrameCount);
        Assert.True(snapshot.TryGetHtml("/31", out PublicHtmlArtifact updated));
        Assert.Contains("overlay-31", System.Text.Encoding.UTF8.GetString(updated.Bytes.Span), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AtomicSwap_ConcurrentReadersSeeOnlyCompleteReadonlyFramesWithoutSliceCopy()
    {
        byte[] firstBytes = Enumerable.Repeat((byte)1, 1024).ToArray();
        byte[] secondBytes = Enumerable.Repeat((byte)2, 1024).ToArray();
        PublicHotReadSnapshot first = Snapshot(1, 42, new PublicBinaryArtifact(firstBytes, "\"1\"", "public", 1, AedsFrameType.ArticleDetail));
        PublicHotReadSnapshot second = Snapshot(2, 42, new PublicBinaryArtifact(secondBytes, "\"2\"", "public", 2, AedsFrameType.ArticleDetail));
        var store = new PublicHotReadStore();
        store.Publish(first);
        var failures = new List<string>();
        object failureGate = new();

        Task reader = Task.Run(() =>
        {
            for (int index = 0; index < 20_000; index++)
            {
                PublicHotReadSnapshot current = store.Current;
                if (!current.TryGetArticle(42, out PublicBinaryArtifact artifact)
                    || (artifact.Frame.Span[0] != 1 && artifact.Frame.Span[0] != 2)
                    || artifact.Frame.Span.IndexOfAnyExcept(artifact.Frame.Span[0]) >= 0)
                {
                    lock (failureGate) failures.Add("partial-frame");
                }
            }
        });
        for (int index = 0; index < 2000; index++)
        {
            store.Publish((index & 1) == 0 ? second : first);
        }
        await reader;

        Assert.Empty(failures);
        Assert.True(store.Current.TryGetArticle(42, out PublicBinaryArtifact visible));
        Assert.True(MemoryMarshal.TryGetArray(visible.Frame, out ArraySegment<byte> segment));
        Assert.Same(firstBytes, segment.Array);
    }

    private static PublicHotReadSnapshot Snapshot(long version, int id, PublicBinaryArtifact artifact)
        => new(
            version,
            new Dictionary<int, PublicBinaryArtifact> { [id] = artifact }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, DateTimeOffset.UtcNow));

    private static PublicBinaryArtifact Artifact(int raw, int brotli, int gzip, long version)
        => new(
            new byte[raw],
            $"\"raw-{version}\"",
            "public,max-age=60",
            version,
            AedsFrameType.ArticleDetail,
            new byte[brotli],
            brotli > 0 ? $"\"br-{version}\"" : string.Empty,
            new byte[gzip],
            gzip > 0 ? $"\"gzip-{version}\"" : string.Empty);

    private static PublicHtmlArtifact Html(string value)
        => new(System.Text.Encoding.UTF8.GetBytes(value), "text/html", $"\"{value}\"", "public,max-age=60");
}
