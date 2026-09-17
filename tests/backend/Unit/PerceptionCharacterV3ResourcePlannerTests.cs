using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class PerceptionCharacterV3Tests
{
    [Fact]
    public void ResourcePlanner_ReturnsEveryAuditableDisposition()
    {
        var planner = new PerceptionCharacterV3ResourcePlanner(new PerceptionCharacterV3ResourcePlannerOptions());
        PerceptionCharacterV3PoolInventory high = Inventory(500, 500);
        PerceptionCharacterV3PoolInventory low = Inventory(20, 20);
        PerceptionCharacterV3PoolInventory empty = Inventory(0, 0);

        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3,
            planner.Plan(Input("comment.create", high, escalation: 2)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.UseCredentialStepUp,
            planner.Plan(Input("account.recovery", high, passkey: true)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.RequireCheaperProof,
            planner.Plan(Input("article.read", high)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.QueueForModeration,
            planner.Plan(Input("comment.create", low)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.Throttle,
            planner.ResolveLeaseFailure(
                planner.Plan(Input("comment.create", high, escalation: 2)),
                PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.Block,
            planner.Plan(Input("admin.security.rotate", empty)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.Unavailable,
            planner.Plan(Input("write.other", high with
            {
                RedisAvailable = false
            }, redisAvailable: false)).Disposition);
    }

    [Fact]
    public void ResourcePlanner_LowAndCriticalWatermarksReserveCapacityByActionPriority()
    {
        var planner = new PerceptionCharacterV3ResourcePlanner(new PerceptionCharacterV3ResourcePlannerOptions());

        PerceptionCharacterV3ResourceDecision lowComment = planner.Plan(Input(
            "comment.create",
            Inventory(20, 20),
            escalation: 1));
        PerceptionCharacterV3ResourceDecision criticalComment = planner.Plan(Input(
            "comment.create",
            Inventory(5, 5),
            escalation: 3));
        PerceptionCharacterV3ResourceDecision criticalRecovery = planner.Plan(Input(
            "account.recovery",
            Inventory(5, 5),
            escalation: 3));

        Assert.Equal(PerceptionCharacterV3WatermarkState.Low, lowComment.Watermark);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.QueueForModeration, lowComment.Disposition);
        Assert.Equal(PerceptionCharacterV3WatermarkState.Critical, criticalComment.Watermark);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.QueueForModeration, criticalComment.Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3, criticalRecovery.Disposition);
    }

    [Fact]
    public void ResourcePlanner_CoversAnonymousSessionAdminNotificationAndPublicReadBoundaries()
    {
        var planner = new PerceptionCharacterV3ResourcePlanner(new PerceptionCharacterV3ResourcePlannerOptions());
        PerceptionCharacterV3PoolInventory high = Inventory(500, 500);

        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3,
            planner.Plan(Input("anonymous.account.enrollment", high, escalation: 2, authenticated: false)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3,
            planner.Plan(Input("comment.create", high, escalation: 2, authenticated: true)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.UseCredentialStepUp,
            planner.Plan(Input("admin.security.rotate", high, passkey: true, authenticated: true)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3,
            planner.Plan(Input("notification.subscribe", high, escalation: 2, authenticated: false)).Disposition);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.RequireCheaperProof,
            planner.Plan(Input("public.article.read", high, authenticated: false)).Disposition);
    }

    [Fact]
    public void ResourcePlanner_RejectsImpossibleWatermarksBudgetsAndDispositionCoverage()
    {
        Assert.Throws<InvalidOperationException>(() => new PerceptionCharacterV3ResourcePlannerOptions
        {
            CriticalWatermark = 10,
            LowWatermark = 10
        }.Validate());
        Assert.Throws<InvalidOperationException>(() => new PerceptionCharacterV3ResourcePlannerOptions
        {
            LeasePerMinute = 10,
            LeaseRollingHour = 9
        }.Validate());
        Assert.Throws<InvalidOperationException>(() => new PerceptionCharacterV3ResourcePlannerOptions
        {
            ExhaustionDispositions = []
        }.Validate());
        Assert.Throws<InvalidOperationException>(() => new PerceptionCharacterV3ResourcePlanner(
            new PerceptionCharacterV3ResourcePlannerOptions()).ValidateInventory(Inventory(99, 100)));
    }

    [Fact]
    public void ResourcePlanner_ReloadDisablesAllocationsWithoutRestart()
    {
        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{PerceptionCharacterV3ResourcePlannerOptions.SectionName}:AllocationsEnabled"] = "true"
            })
            .Build();
        var planner = new PerceptionCharacterV3ResourcePlanner(configuration);
        Assert.Equal(PerceptionCharacterV3ResourceDisposition.AllocateV3,
            planner.Plan(Input("comment.create", Inventory(500, 500), escalation: 2)).Disposition);

        configuration[$"{PerceptionCharacterV3ResourcePlannerOptions.SectionName}:AllocationsEnabled"] = "false";
        configuration.Reload();

        Assert.Equal(PerceptionCharacterV3ResourceDisposition.QueueForModeration,
            planner.Plan(Input("comment.create", Inventory(500, 500), escalation: 2)).Disposition);
    }

    [Fact]
    public void Replenishment_IsBoundedIdleOnlyAndStopsAtHighWatermarkOrPressure()
    {
        var planner = new PerceptionCharacterV3ResourcePlanner(new PerceptionCharacterV3ResourcePlannerOptions
        {
            ReplenishmentMaxEntries = 7,
            ReplenishmentMaxBytes = 123_456
        });

        PerceptionCharacterV3ReplenishmentDecision allowed = planner.PlanReplenishment(new(
            Inventory(20, 20), false, false, false, false, false));
        Assert.True(allowed.Allowed);
        Assert.Equal(7, allowed.MaximumEntries);
        Assert.Equal(123_456, allowed.MaximumBytes);
        Assert.False(planner.PlanReplenishment(new(
            Inventory(20, 20), true, false, false, false, false)).Allowed);
        Assert.False(planner.PlanReplenishment(new(
            Inventory(20, 20), false, true, false, false, false)).Allowed);
        Assert.False(planner.PlanReplenishment(new(
            Inventory(500, 500), false, false, false, false, false)).Allowed);
    }

    [Fact]
    public void ResourceMetrics_ExposeOnlyBoundedTagsAndExactIssuedBytes()
    {
        var measurements = new List<(long Value, Dictionary<string, object?> Tags)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == FsusObservability.MeterName &&
                instrument.Name.StartsWith("fsus.security.perception_character_v3.", StringComparison.Ordinal))
                meterListener.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<long>((instrument, measurement, tags, _) =>
        {
            var captured = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object?> tag in tags)
                captured[tag.Key] = tag.Value;
            measurements.Add((measurement, captured));
        });
        listener.Start();

        FsusObservability.RecordPerceptionCharacterV3Allocation("allocated", "normal", "comment", "visual", 12_345);

        Assert.Contains(measurements, item =>
            item.Value == 12_345 &&
            item.Tags.Keys.Order(StringComparer.Ordinal).SequenceEqual(new[]
            {
                "fsus.security.action_class",
                "fsus.security.disposition",
                "fsus.security.representation",
                "fsus.security.watermark"
            }));
        Assert.DoesNotContain(measurements.SelectMany(item => item.Tags.Keys), key =>
            key.Contains("ip", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("challenge", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("token", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("answer", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [Trait("Category", "LocalLoad")]
    public void SaturatedPlannerPath_HasBoundedCpuAndAllocation()
    {
        var planner = new PerceptionCharacterV3ResourcePlanner(new PerceptionCharacterV3ResourcePlannerOptions());
        PerceptionCharacterV3ResourceDecision planned = planner.Plan(Input("comment.create", Inventory(500, 500), escalation: 2));
        PerceptionCharacterV3ResourcePlanInput empty = Input("comment.create", Inventory(0, 0), escalation: 2);
        _ = planner.ResolveLeaseFailure(planned, PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted);
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        var stopwatch = Stopwatch.StartNew();

        for (int index = 0; index < 20_000; index++)
        {
            PerceptionCharacterV3ResourceDecision decision = planner.ResolveLeaseFailure(
                planned,
                PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted);
            Assert.Equal(PerceptionCharacterV3ResourceDisposition.Throttle, decision.Disposition);
            PerceptionCharacterV3ResourceDecision emptyDecision = planner.Plan(empty);
            Assert.Equal(PerceptionCharacterV3ResourceDisposition.QueueForModeration, emptyDecision.Disposition);
        }

        stopwatch.Stop();
        long allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(3), $"saturated planner elapsed {stopwatch.Elapsed}");
        Assert.True(allocated < 32 * 1024 * 1024, $"saturated planner allocated {allocated} bytes");
    }

    private static PerceptionCharacterV3PoolInventory Inventory(int visual, int audio)
        => new("generation", visual, audio, visual + audio, 0, 0, false, false, true);

    private static PerceptionCharacterV3ResourcePlanInput Input(
        string action,
        PerceptionCharacterV3PoolInventory inventory,
        int escalation = 0,
        bool passkey = false,
        bool redisAvailable = true,
        bool authenticated = true)
        => new(
            action,
            PerceptionCharacterV3Representation.Visual,
            inventory,
            escalation,
            100,
            authenticated,
            passkey,
            redisAvailable);
}
