using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests;

public sealed class PublicAotSsrRuntimeStateTests
{
    [Fact]
    public void CircuitBreaker_OpensAfterWorkerFailures_AndClosesAfterHalfOpenSuccess()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-06-16T00:00:00Z"));
        PublicAotSsrRuntimeState state = CreateState(clock, circuitThreshold: 2, circuitCooldownSeconds: 30);
        PublicAotBackfillRequest first = Request("home");
        PublicAotBackfillRequest probe = Request("archive");

        Assert.True(state.TryBeginBackfill(first, out string firstReason));
        Assert.Equal(string.Empty, firstReason);
        state.RecordBackfillFailure(first, PublicAotSsrFailureClass.WorkerTimeout, "public AOT pooled SSR worker timed out", TimeSpan.FromSeconds(1));
        Assert.Equal(PublicAotSsrCircuitState.Closed, state.CreateSnapshot(queueDepth: 0, queueCapacity: 32).Circuit.State);

        Assert.True(state.TryBeginBackfill(first, out _));
        state.RecordBackfillFailure(first, PublicAotSsrFailureClass.WorkerTimeout, "public AOT pooled SSR worker timed out", TimeSpan.FromSeconds(1));

        PublicAotSsrRuntimeSnapshot open = state.CreateSnapshot(queueDepth: 0, queueCapacity: 32);
        Assert.Equal(PublicAotSsrCircuitState.Open, open.Circuit.State);
        Assert.Equal(2, open.Circuit.ConsecutiveWorkerFailures);
        Assert.Equal("public AOT pooled SSR worker timed out", open.LastFailure?.Message);

        Assert.False(state.TryBeginBackfill(Request("article:42"), out string blockedReason));
        Assert.Equal("circuit-open", blockedReason);

        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.True(state.TryBeginBackfill(probe, out string probeReason));
        Assert.Equal("half-open-probe", probeReason);
        Assert.Equal(PublicAotSsrCircuitState.HalfOpen, state.CreateSnapshot(queueDepth: 0, queueCapacity: 32).Circuit.State);

        Assert.False(state.TryBeginBackfill(Request("article:43"), out string halfOpenReason));
        Assert.Equal("circuit-half-open-probe-in-flight", halfOpenReason);

        state.RecordBackfillSuccess(probe, TimeSpan.FromMilliseconds(12));

        PublicAotSsrRuntimeSnapshot closed = state.CreateSnapshot(queueDepth: 0, queueCapacity: 32);
        Assert.Equal(PublicAotSsrCircuitState.Closed, closed.Circuit.State);
        Assert.Equal(0, closed.Circuit.ConsecutiveWorkerFailures);
    }

    [Fact]
    public void RouteQuarantine_SkipsRepeatedFailingRoute_UntilInvalidatedOrExpired()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-06-16T00:00:00Z"));
        PublicAotSsrRuntimeState state = CreateState(clock, circuitThreshold: 99, quarantineThreshold: 2, quarantineTtlSeconds: 60);
        PublicAotBackfillRequest request = Request("article:42");

        state.RecordBackfillFailure(request, PublicAotSsrFailureClass.RendererContract, "public_aot_worker_invalid_aeds", TimeSpan.FromMilliseconds(5));
        state.RecordBackfillFailure(request, PublicAotSsrFailureClass.RendererContract, "public_aot_worker_invalid_aeds", TimeSpan.FromMilliseconds(5));

        PublicAotSsrRuntimeSnapshot quarantined = state.CreateSnapshot(queueDepth: 0, queueCapacity: 32);
        PublicAotRouteQuarantineSnapshot quarantine = Assert.Single(quarantined.RouteQuarantines);
        Assert.Equal(PublicPageKind.ArticleDetail, quarantine.Kind);
        Assert.Equal("article:42", quarantine.RouteKey);
        Assert.Equal("public_aot_worker_invalid_aeds", quarantine.LastFailureReason);

        Assert.False(state.TryBeginBackfill(request, out string blockedReason));
        Assert.Equal("route-quarantined", blockedReason);

        state.ClearRouteQuarantine(PublicPageKind.ArticleDetail, "article:42");
        Assert.True(state.TryBeginBackfill(request, out _));
        state.RecordBackfillSuccess(request, TimeSpan.FromMilliseconds(5));

        state.RecordBackfillFailure(request, PublicAotSsrFailureClass.RendererContract, "public_aot_worker_invalid_aeds", TimeSpan.FromMilliseconds(5));
        state.RecordBackfillFailure(request, PublicAotSsrFailureClass.RendererContract, "public_aot_worker_invalid_aeds", TimeSpan.FromMilliseconds(5));
        clock.Advance(TimeSpan.FromSeconds(61));

        Assert.True(state.TryBeginBackfill(request, out _));
    }

    [Fact]
    public void HalfOpenProbe_WhenSchedulerCannotStart_ReleasesProbeSlot()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-06-16T00:00:00Z"));
        PublicAotSsrRuntimeState state = CreateState(clock, circuitThreshold: 1, circuitCooldownSeconds: 10);
        PublicAotBackfillRequest failed = Request("home");
        state.RecordBackfillFailure(failed, PublicAotSsrFailureClass.WorkerTimeout, "public AOT pooled SSR worker timed out", TimeSpan.FromSeconds(1));
        clock.Advance(TimeSpan.FromSeconds(11));

        Assert.True(state.TryBeginBackfill(Request("article:42"), out string firstProbeReason));
        Assert.Equal("half-open-probe", firstProbeReason);

        state.RecordBackfillDropped(Request("article:42"), "queue-full", queueDepth: 32);

        Assert.True(state.TryBeginBackfill(Request("article:43"), out string secondProbeReason));
        Assert.Equal("half-open-probe", secondProbeReason);
    }

    [Fact]
    public void Snapshot_ReportsSchedulingCountersAndQueueDepth()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-06-16T00:00:00Z"));
        PublicAotSsrRuntimeState state = CreateState(clock);
        PublicAotBackfillRequest request = Request("home");

        state.RecordBackfillScheduled(request, queueDepth: 3);
        state.RecordBackfillDropped(request, "queue-full", queueDepth: 3);

        PublicAotSsrRuntimeSnapshot snapshot = state.CreateSnapshot(queueDepth: 3, queueCapacity: 32);

        Assert.Equal(1, snapshot.ScheduledBackfills);
        Assert.Equal(1, snapshot.DroppedBackfills);
        Assert.Equal("queue-full", snapshot.LastDropReason);
        Assert.Equal(3, snapshot.QueueDepth);
        Assert.Equal(32, snapshot.QueueCapacity);
    }

    private static PublicAotSsrRuntimeState CreateState(
        TimeProvider clock,
        int circuitThreshold = 3,
        int circuitCooldownSeconds = 30,
        int quarantineThreshold = 3,
        int quarantineTtlSeconds = 120)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:SsrCircuitFailureThreshold"] = circuitThreshold.ToString(),
                ["PublicAot:SsrCircuitCooldownSeconds"] = circuitCooldownSeconds.ToString(),
                ["PublicAot:SsrRouteQuarantineFailureThreshold"] = quarantineThreshold.ToString(),
                ["PublicAot:SsrRouteQuarantineTtlSeconds"] = quarantineTtlSeconds.ToString()
            })
            .Build();
        return new PublicAotSsrRuntimeState(configuration, clock);
    }

    private static PublicAotBackfillRequest Request(string routeKey)
        => new(
            routeKey.StartsWith("article:", StringComparison.Ordinal) ? PublicPageKind.ArticleDetail : PublicPageKind.Home,
            routeKey,
            routeKey.StartsWith("article:", StringComparison.Ordinal)
                ? $"/article/{routeKey["article:".Length..]}"
                : "/",
            string.Empty,
            $"cache:{routeKey}");

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan value) => _utcNow += value;
    }
}
