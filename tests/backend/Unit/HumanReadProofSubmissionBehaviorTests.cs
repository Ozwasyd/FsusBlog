using System.Diagnostics;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HumanReadProofSubmissionBehaviorTests
{
    [Fact]
    public async Task SubmitAsync_ValidArticleProofWritesOneAggregateContributionAndUsesBoundedLeases()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9000));

        Assert.True(submit.Counted);
        Assert.Equal("counted", submit.Status);
        Assert.True(harness.Channel.Reader.TryRead(out VisitLogMessage message));
        Assert.Equal(HumanReadEventTypes.ArticleRead, message.EventType);
        Assert.Equal(42, message.ArticleId);
        Assert.Equal(new DateTime(2026, 5, 13, 0, 0, 0, DateTimeKind.Utc), message.AggregateHourUtc);
        Assert.Equal(ReadDwellBuckets.Under10Seconds, message.DwellBucket);
        Assert.Null(typeof(VisitLogMessage).GetProperty("IP"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("RouteKey"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("ViewerKeyHash"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("ProofId"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("DwellMs"));
        Assert.False(harness.Channel.Reader.TryRead(out _));
        Assert.Contains(
            harness.Cache.Acquisitions,
            item => item.Acquired && item.Identity.StartsWith("proof:", StringComparison.Ordinal) && item.Ttl == TimeSpan.FromMinutes(10));
        Assert.Contains(
            harness.Cache.Acquisitions,
            item => item.Acquired
                && item.Identity.StartsWith("dedup:article:42:epoch:", StringComparison.Ordinal)
                && item.Ttl == HumanReadProofService.DedupLeaseTtl);
    }

    [Fact]
    public async Task SubmitAsync_ReplayedProofDoesNotWriteSecondAggregateContribution()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        var request = new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 9000);

        HumanReadSubmitResponse first = await harness.Service.SubmitAsync(harness.CreateBrowserContext(), request);
        HumanReadSubmitResponse second = await harness.Service.SubmitAsync(harness.CreateBrowserContext(), request);

        Assert.True(first.Counted);
        Assert.False(second.Counted);
        Assert.Equal("proof_replayed", second.Status);
        Assert.True(harness.Channel.Reader.TryRead(out _));
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_TamperedRouteDoesNotWriteAggregateContribution()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:43", 43, 9000));

        Assert.False(submit.Counted);
        Assert.Equal("proof_invalid", submit.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_DwellShorterThanChallengeMinimumIsRejected()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromSeconds(3));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 3000));

        Assert.False(submit.Counted);
        Assert.Equal("dwell_too_short", submit.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_ExpiredChallengeIsRejectedBeforeReplayLease()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromMilliseconds(1));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 300001));

        Assert.False(submit.Counted);
        Assert.Equal("proof_expired", submit.Status);
        Assert.Empty(harness.Cache.Acquisitions);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_DifferentProofForSameViewerIsDeduplicated()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse firstChallenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        HumanReadChallengeResponse secondChallenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse first = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(firstChallenge.Token, "article", "article:42", 42, 9000));
        HumanReadSubmitResponse second = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(secondChallenge.Token, "article", "article:42", 42, 9000));

        Assert.True(first.Counted);
        Assert.False(second.Counted);
        Assert.Equal("duplicate_viewer", second.Status);
        Assert.True(harness.Channel.Reader.TryRead(out _));
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task DedupIdentity_IsUnlinkableAcrossArticleAndShortEpoch()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        await SubmitArticleAsync(harness, 42);
        await SubmitArticleAsync(harness, 43);

        string[] firstEpochKeys = harness.Cache.Acquisitions
            .Where(static item => item.Acquired && item.Identity.StartsWith("dedup:article:", StringComparison.Ordinal))
            .Select(static item => item.Identity)
            .ToArray();
        Assert.Equal(2, firstEpochKeys.Length);
        Assert.NotEqual(firstEpochKeys[0].Split(':')[^1], firstEpochKeys[1].Split(':')[^1]);

        harness.Time.Advance(HumanReadProofService.DedupEpochDuration);
        await SubmitArticleAsync(harness, 42);
        string[] article42Keys = harness.Cache.Acquisitions
            .Where(static item => item.Acquired && item.Identity.StartsWith("dedup:article:42:", StringComparison.Ordinal))
            .Select(static item => item.Identity)
            .ToArray();

        Assert.Equal(2, article42Keys.Length);
        Assert.NotEqual(article42Keys[0], article42Keys[1]);
        Assert.All(
            harness.Cache.Acquisitions.Where(static item => item.Identity.StartsWith("dedup:", StringComparison.Ordinal)),
            static item => Assert.Equal(HumanReadProofService.DedupLeaseTtl, item.Ttl));
    }

    [Fact]
    public async Task SubmitAsync_DedupInfrastructureFailureDropsTheStatisticWithoutRawIpFallback()
    {
        const string rawIp = "203.0.113.177";
        var logger = new CollectingLogger<HumanReadProofService>();
        await using var harness = HumanReadProofTestHarness.Create(logger: logger);
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(remoteIp: rawIp),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        harness.Cache.AcquireException = new InvalidOperationException($"cache endpoint unavailable for {rawIp}");

        HumanReadSubmitResponse response = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(remoteIp: rawIp),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9_000));

        Assert.False(response.Counted);
        Assert.Equal("dedup_unavailable", response.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
        Assert.NotEmpty(logger.Entries);
        Assert.All(logger.Entries, entry => Assert.DoesNotContain(rawIp, entry, StringComparison.Ordinal));
    }

    [Fact]
    public async Task SubmitAsync_SaturatedChannelAndTelemetryDoNotRetainRawNetworkStrings()
    {
        var logger = new CollectingLogger<HumanReadProofService>();
        await using var harness = HumanReadProofTestHarness.Create(logger: logger);
        for (int index = 0; index < VisitLogChannel.Capacity; index++)
        {
            Assert.True(harness.Channel.TryWrite(new VisitLogMessage(
                new DateTime(2026, 5, 13, 0, 0, 0, DateTimeKind.Utc),
                HumanReadEventTypes.SiteRead,
                null,
                ReadDwellBuckets.Under10Seconds)));
        }

        using Activity activity = new Activity("read-proof-privacy-fixture").Start();
        (WeakReference<string> rawIp, WeakReference<string> forwardedFor) =
            await SubmitWithEphemeralNetworkStringsAsync(harness);

        Assert.Equal(VisitLogChannel.Capacity, harness.Channel.QueuedCount);
        Assert.Equal(1, harness.Channel.SaturatedWriteCount);
        Assert.Contains(logger.Entries, static entry => entry.Contains("Saturated: True", StringComparison.Ordinal));
        Assert.DoesNotContain(activity.TagObjects, static tag => tag.Key.Contains("ip", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(activity.Baggage, static item => item.Key.Contains("ip", StringComparison.OrdinalIgnoreCase));

        ForceFullCollection();
        Assert.False(rawIp.TryGetTarget(out _));
        Assert.False(forwardedFor.TryGetTarget(out _));
    }

    [Fact]
    public async Task SubmitAsync_IgnoresUntrustedProxyHeadersAndNormalizesMappedIpv4()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        var challengeContext = harness.CreateBrowserContext(remoteIp: "::ffff:192.0.2.88");
        challengeContext.Request.Headers["X-Forwarded-For"] = "203.0.113.90, 10.0.0.4";
        challengeContext.Request.Headers["X-Real-IP"] = "malformed";
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                challengeContext,
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        var submitContext = harness.CreateBrowserContext(remoteIp: "192.0.2.88");
        submitContext.Request.Headers["X-Forwarded-For"] = "not-an-ip";
        submitContext.Request.Headers["X-Real-IP"] = "198.51.100.250";

        HumanReadSubmitResponse response = await harness.Service.SubmitAsync(
            submitContext,
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9_000));

        Assert.True(response.Counted);
        Assert.True(harness.Channel.Reader.TryRead(out VisitLogMessage message));
        string transport = message.ToString();
        Assert.DoesNotContain("192.0.2.88", transport, StringComparison.Ordinal);
        Assert.DoesNotContain("203.0.113.90", transport, StringComparison.Ordinal);
        Assert.DoesNotContain("198.51.100.250", transport, StringComparison.Ordinal);
        Assert.All(harness.Cache.Acquisitions, acquisition =>
        {
            Assert.DoesNotContain("192.0.2.88", acquisition.Identity, StringComparison.Ordinal);
            Assert.DoesNotContain("203.0.113.90", acquisition.Identity, StringComparison.Ordinal);
            Assert.DoesNotContain("198.51.100.250", acquisition.Identity, StringComparison.Ordinal);
        });
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task<(WeakReference<string> RawIp, WeakReference<string> ForwardedFor)>
        SubmitWithEphemeralNetworkStringsAsync(HumanReadProofTestHarness harness)
    {
        string rawIp = new("203.0.113.241".ToCharArray());
        string forwardedFor = new("198.51.100.90, 10.0.0.5".ToCharArray());
        var rawIpReference = new WeakReference<string>(rawIp);
        var forwardedReference = new WeakReference<string>(forwardedFor);
        var challengeContext = harness.CreateBrowserContext(remoteIp: rawIp);
        challengeContext.Request.Headers["X-Forwarded-For"] = forwardedFor;
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                challengeContext,
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        var submitContext = harness.CreateBrowserContext(remoteIp: rawIp);
        submitContext.Request.Headers["X-Forwarded-For"] = forwardedFor;
        HumanReadSubmitResponse response = await harness.Service.SubmitAsync(
            submitContext,
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9_000));
        Assert.True(response.Counted);
        return (rawIpReference, forwardedReference);
    }

    private static void ForceFullCollection()
    {
        for (int index = 0; index < 3; index++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
        }
    }

    private static async Task SubmitArticleAsync(HumanReadProofTestHarness harness, int articleId)
    {
        string route = $"article:{articleId}";
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", route, articleId)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        HumanReadSubmitResponse response = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "article", route, articleId, 9000));
        Assert.True(response.Counted);
        Assert.True(harness.Channel.Reader.TryRead(out _));
    }

    private sealed class CollectingLogger<T> : ILogger<T>
    {
        private readonly List<string> _entries = [];

        internal IReadOnlyList<string> Entries
        {
            get
            {
                lock (_entries)
                {
                    return [.. _entries];
                }
            }
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            string entry = formatter(state, exception);
            if (exception is not null)
            {
                entry = $"{entry} | {exception}";
            }

            lock (_entries)
            {
                _entries.Add(entry);
            }
        }
    }
}
