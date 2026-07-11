using System.Diagnostics;
using System.Net;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RateLimiterRejectionRiskSamplerTests
{
    private static readonly DateTimeOffset FixedUtcNow = new(2026, 7, 11, 6, 0, 0, TimeSpan.Zero);

    [Fact]
    public void MatchedAndUnmatchedHighCardinalityRawPaths_CollapseToLogicalRoutes()
    {
        var sampler = CreateSampler(maxTrackedBuckets: 16);
        RouteEndpoint articleEndpoint = CreateRouteEndpoint("/article/{id:long}", "article-detail");
        DefaultHttpContext matched = CreateContext("203.0.113.10", "/article/0", articleEndpoint);
        DefaultHttpContext unmatched = CreateContext("203.0.113.10", "/missing/0");
        int matchedWrites = 0;
        int unmatchedWrites = 0;

        for (int index = 0; index < 10_000; index++)
        {
            matched.Request.Path = $"/article/{index}";
            unmatched.Request.Path = $"/missing/{index}";
            if (sampler.Sample(matched) == RateLimiterRiskSampleDecision.WriteRiskSignal) matchedWrites++;
            if (sampler.Sample(unmatched) == RateLimiterRiskSampleDecision.WriteRiskSignal) unmatchedWrites++;
        }

        Assert.Equal("GET|/article/{id:long}", RateLimiterRejectionRouteIdentity.Resolve(matched));
        Assert.Equal("GET|unmatched", RateLimiterRejectionRouteIdentity.Resolve(unmatched));
        Assert.Equal(4, matchedWrites);
        Assert.Equal(4, unmatchedWrites);
        Assert.Equal(2, sampler.Snapshot().TrackedBucketCount);
    }

    [Fact]
    public void RouteIdentity_BoundsLongEndpointMetadataAndUnknownMethods()
    {
        var endpoint = new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(),
            new string('x', 8_192));
        DefaultHttpContext context = CreateContext("2001:db8::1", "/attacker-controlled", endpoint, "CUSTOM-METHOD");

        string identity = RateLimiterRejectionRouteIdentity.Resolve(context);

        Assert.True(identity.StartsWith("OTHER|sha256:", StringComparison.Ordinal));
        Assert.InRange(identity.Length, 1, 80);
        Assert.DoesNotContain("attacker-controlled", identity, StringComparison.Ordinal);
    }

    [Fact]
    public void CapacityBoundary_DropsNewBucketsButPreservesExistingBucketWriteLimit()
    {
        const int capacity = 64;
        const long minute = 1_000;
        var sampler = CreateSampler(maxTrackedBuckets: capacity);
        int writes = 0;
        int capacityDrops = 0;

        for (int index = 0; index < 10_000; index++)
        {
            RateLimiterRiskSampleDecision decision = sampler.Sample(
                minute,
                $"client-{index}",
                $"route-{index}");
            if (decision == RateLimiterRiskSampleDecision.WriteRiskSignal) writes++;
            if (decision == RateLimiterRiskSampleDecision.DropCapacity) capacityDrops++;
        }

        Assert.Equal(capacity, writes);
        Assert.Equal(10_000 - capacity, capacityDrops);
        Assert.Equal(RateLimiterRiskSampleDecision.WriteRiskSignal, sampler.Sample(minute, "client-0", "route-0"));
        Assert.Equal(RateLimiterRiskSampleDecision.WriteRiskSignal, sampler.Sample(minute, "client-0", "route-0"));
        Assert.Equal(RateLimiterRiskSampleDecision.WriteRiskSignal, sampler.Sample(minute, "client-0", "route-0"));
        Assert.Equal(RateLimiterRiskSampleDecision.DropWriteLimit, sampler.Sample(minute, "client-0", "route-0"));

        RateLimiterRejectionSamplerSnapshot snapshot = sampler.Snapshot();
        Assert.Equal(capacity, snapshot.TrackedBucketCount);
        Assert.Equal(10_000 - capacity, snapshot.CapacityDropCount);
        Assert.Equal(1, snapshot.WriteLimitDropCount);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public void CrossMinuteRotation_ReplacesTheWholeWindowOnceUnderConcurrency()
    {
        const int capacity = 128;
        var sampler = CreateSampler(maxTrackedBuckets: capacity);
        for (int index = 0; index < capacity; index++)
        {
            Assert.Equal(
                RateLimiterRiskSampleDecision.WriteRiskSignal,
                sampler.Sample(2_000, $"old-client-{index}", "route"));
        }

        int writes = 0;
        int capacityDrops = 0;
        Parallel.For(0, 20_000, index =>
        {
            RateLimiterRiskSampleDecision decision = sampler.Sample(
                2_001,
                $"new-client-{index}",
                "route");
            if (decision == RateLimiterRiskSampleDecision.WriteRiskSignal) Interlocked.Increment(ref writes);
            if (decision == RateLimiterRiskSampleDecision.DropCapacity) Interlocked.Increment(ref capacityDrops);
        });

        RateLimiterRejectionSamplerSnapshot snapshot = sampler.Snapshot();
        Assert.Equal(2_001, snapshot.WindowMinute);
        Assert.Equal(capacity, snapshot.TrackedBucketCount);
        Assert.Equal(2, snapshot.WindowRotationCount);
        Assert.Equal(capacity, writes);
        Assert.Equal(20_000 - capacity, capacityDrops);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public void ConcurrentSameBucket_PreservesExactlyFourRiskWrites()
    {
        var sampler = CreateSampler(maxTrackedBuckets: 32);
        int writes = 0;
        int writeLimitDrops = 0;

        Parallel.For(0, 20_000, _ =>
        {
            RateLimiterRiskSampleDecision decision = sampler.Sample(3_000, "same-client", "same-route");
            if (decision == RateLimiterRiskSampleDecision.WriteRiskSignal) Interlocked.Increment(ref writes);
            if (decision == RateLimiterRiskSampleDecision.DropWriteLimit) Interlocked.Increment(ref writeLimitDrops);
        });

        RateLimiterRejectionSamplerSnapshot snapshot = sampler.Snapshot();
        Assert.Equal(4, writes);
        Assert.Equal(20_000 - 4, writeLimitDrops);
        Assert.Equal(1, snapshot.TrackedBucketCount);
        Assert.Equal(0, snapshot.CapacityDropCount);
    }

    [Fact]
    public void AnonymousLoginAdminNotificationStreamAndBinaryRoutes_KeepIndependentCaps()
    {
        var sampler = CreateSampler(maxTrackedBuckets: 32);
        var scenarios = new[]
        {
            CreateContext("203.0.113.80", "/api/binary/article/1", CreateRouteEndpoint("/api/binary/article/{id:long}", "binary-article")),
            CreateContext("203.0.113.80", "/api/binary/auth/session", CreateRouteEndpoint("/api/binary/auth/session", "login-session"), principal: AccountPrincipal()),
            CreateContext("203.0.113.80", "/api/binary/admin/users", CreateRouteEndpoint("/api/binary/admin/users", "admin-users"), principal: AdminPrincipal()),
            CreateContext("203.0.113.80", "/api/notifications/stream", CreateRouteEndpoint("/api/notifications/stream", "notification-stream"), principal: AccountPrincipal()),
            CreateContext("203.0.113.80", "/api/binary/read-proof/submit.aeds", CreateRouteEndpoint("/api/binary/read-proof/submit.aeds", "binary-read-proof"), method: HttpMethods.Post)
        };

        foreach (DefaultHttpContext context in scenarios)
        {
            RateLimiterRiskSampleDecision[] decisions = Enumerable.Range(0, 5)
                .Select(_ => sampler.Sample(context))
                .ToArray();
            Assert.Equal(4, decisions.Count(static decision => decision == RateLimiterRiskSampleDecision.WriteRiskSignal));
            Assert.Equal(RateLimiterRiskSampleDecision.DropWriteLimit, decisions[^1]);
        }

        Assert.Equal(scenarios.Length, sampler.Snapshot().TrackedBucketCount);
    }

    [Fact]
    [Trait("Category", "Performance")]
    [Trait("Category", "Concurrency")]
    public void SaturatedBucketLookup_P95RemainsStableFrom64To4096TrackedBuckets()
    {
        const long minute = 4_000;
        var small = CreateSaturatedSampler(64, minute);
        var large = CreateSaturatedSampler(4_096, minute);
        string[] missingSubjects = Enumerable.Range(0, 512)
            .Select(index => $"untracked-client-{index}")
            .ToArray();

        for (int warmup = 0; warmup < 8; warmup++)
        {
            MeasureCapacityDropBatch(small, minute, missingSubjects);
            MeasureCapacityDropBatch(large, minute, missingSubjects);
        }

        const int batches = 64;
        double[] smallSamples = new double[batches];
        double[] largeSamples = new double[batches];
        for (int batch = 0; batch < batches; batch++)
        {
            if ((batch & 1) == 0)
            {
                smallSamples[batch] = MeasureCapacityDropBatch(small, minute, missingSubjects);
                largeSamples[batch] = MeasureCapacityDropBatch(large, minute, missingSubjects);
            }
            else
            {
                largeSamples[batch] = MeasureCapacityDropBatch(large, minute, missingSubjects);
                smallSamples[batch] = MeasureCapacityDropBatch(small, minute, missingSubjects);
            }
        }

        double smallP95Ms = Percentile(smallSamples, 0.95);
        double largeP95Ms = Percentile(largeSamples, 0.95);
        double largeBudgetMs = Math.Max(0.05d, smallP95Ms * 8d);
        Assert.True(
            largeP95Ms <= largeBudgetMs,
            $"capacity-drop p95 scaled with bucket count: small={smallP95Ms:F6}ms large={largeP95Ms:F6}ms budget={largeBudgetMs:F6}ms");
        Assert.Equal(64, small.Snapshot().TrackedBucketCount);
        Assert.Equal(4_096, large.Snapshot().TrackedBucketCount);
    }

    private static BoundedRateLimiterRejectionRiskSampler CreateSampler(int maxTrackedBuckets)
        => new(4, maxTrackedBuckets, new FixedTimeProvider(FixedUtcNow));

    private static BoundedRateLimiterRejectionRiskSampler CreateSaturatedSampler(int capacity, long minute)
    {
        var sampler = CreateSampler(capacity);
        for (int index = 0; index < capacity; index++)
        {
            Assert.Equal(
                RateLimiterRiskSampleDecision.WriteRiskSignal,
                sampler.Sample(minute, $"tracked-client-{index}", "route"));
        }

        return sampler;
    }

    private static double MeasureCapacityDropBatch(
        BoundedRateLimiterRejectionRiskSampler sampler,
        long minute,
        IReadOnlyList<string> subjects)
    {
        long started = Stopwatch.GetTimestamp();
        for (int index = 0; index < subjects.Count; index++)
        {
            RateLimiterRiskSampleDecision decision = sampler.Sample(minute, subjects[index], "untracked-route");
            if (decision != RateLimiterRiskSampleDecision.DropCapacity)
            {
                throw new InvalidOperationException($"Expected a capacity drop, received {decision}.");
            }
        }

        return Stopwatch.GetElapsedTime(started).TotalMilliseconds / subjects.Count;
    }

    private static double Percentile(double[] samples, double percentile)
    {
        double[] ordered = [.. samples.OrderBy(static value => value)];
        int index = Math.Clamp((int)Math.Ceiling(ordered.Length * percentile) - 1, 0, ordered.Length - 1);
        return ordered[index];
    }

    private static RouteEndpoint CreateRouteEndpoint(string pattern, string displayName)
        => new(
            static _ => Task.CompletedTask,
            RoutePatternFactory.Parse(pattern),
            0,
            new EndpointMetadataCollection(),
            displayName);

    private static DefaultHttpContext CreateContext(
        string clientIp,
        string path,
        Endpoint? endpoint = null,
        string method = "GET",
        ClaimsPrincipal? principal = null)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(clientIp);
        context.Request.Path = path;
        context.Request.Method = method;
        context.User = principal ?? new ClaimsPrincipal(new ClaimsIdentity());
        context.SetEndpoint(endpoint);
        return context;
    }

    private static ClaimsPrincipal AccountPrincipal()
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", "anonymous_account"),
            new Claim("nameid", "42")
        ], "test"));

    private static ClaimsPrincipal AdminPrincipal()
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "17")
        ], "test"));

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
