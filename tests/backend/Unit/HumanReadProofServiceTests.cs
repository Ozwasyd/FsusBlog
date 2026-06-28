using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using System.Security.Claims;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HumanReadProofServiceTests
{
    [Fact]
    public async Task SubmitAsync_ValidArticleProof_WritesSingleHumanReadEvent()
    {
        var fixture = CreateFixture();
        var challenge = await fixture.Service.CreateChallengeAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadChallengeRequest("article", "article:42", 42));
        Assert.NotNull(challenge);

        fixture.Time.Advance(TimeSpan.FromSeconds(9));
        var submit = await fixture.Service.SubmitAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadSubmitRequest(challenge!.Token, "article", "article:42", 42, 9000));

        Assert.True(submit.Counted);
        Assert.True(fixture.Channel.Reader.TryRead(out VisitLogMessage message));
        Assert.Equal("article_read", message.EventType);
        Assert.Equal(42, message.ArticleId);
    }

    [Fact]
    public async Task SubmitAsync_AuthenticatedAccount_DoesNotWriteUserIdToVisitLog()
    {
        var fixture = CreateFixture();
        var challenge = await fixture.Service.CreateChallengeAsync(
            BuildAuthenticatedBrowserContext(fixture.Services, userId: 42),
            new HumanReadChallengeRequest("article", "article:42", 42));
        Assert.NotNull(challenge);

        fixture.Time.Advance(TimeSpan.FromSeconds(9));
        var submit = await fixture.Service.SubmitAsync(
            BuildAuthenticatedBrowserContext(fixture.Services, userId: 42),
            new HumanReadSubmitRequest(challenge!.Token, "article", "article:42", 42, 9000));

        Assert.True(submit.Counted);
        Assert.True(fixture.Channel.Reader.TryRead(out VisitLogMessage message));
        Assert.Null(typeof(VisitLogMessage).GetProperty("UserId"));
        Assert.False(message.ViewerKeyHash is null);
        Assert.False(message.ProofId is null);
    }

    [Fact]
    public void HumanReadAndStats_SourceDoNotUseVisitLogUserIdAsIdentityDimension()
    {
        Assert.Null(typeof(FsusBlog.Server.Entities.VisitLog).GetProperty("UserId"));
        Assert.Null(typeof(FsusBlog.Server.Entities.VisitLog).GetProperty("IP"));
        Assert.NotNull(typeof(FsusBlog.Server.Entities.VisitLog).GetProperty("IpHash"));

        string proof = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/HumanReadProofService.cs");
        string visitLog = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/VisitLog.cs");
        string visitProcessor = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/VisitLog/VisitLogProcessorService.cs");
        string stats = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/StatsService.cs");
        string outputs = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string statsPods = BackendTestPaths.ReadAllTextFromRoot("src/shared/Contracts/Models/StatsPods.cs");
        string frontendStats = BackendTestPaths.ReadAllTextFromRoot("src/frontend/src/api/stats.ts");

        Assert.DoesNotContain("context.GetUserId()", proof, StringComparison.Ordinal);
        Assert.DoesNotContain("int? UserId", visitLog, StringComparison.Ordinal);
        Assert.DoesNotContain("public string IP", visitLog, StringComparison.Ordinal);
        Assert.DoesNotContain("int? UserId", visitProcessor, StringComparison.Ordinal);
        Assert.DoesNotContain("msg.UserId", visitProcessor, StringComparison.Ordinal);
        Assert.DoesNotContain("IP = msg.IP", visitProcessor, StringComparison.Ordinal);
        Assert.DoesNotContain("IP = ip", visitProcessor, StringComparison.Ordinal);
        Assert.DoesNotContain("v.UserId", stats, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisteredVisits", stats, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousVisits", stats, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisteredVisits", outputs, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousVisits", outputs, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisteredVisits", statsPods, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousVisits", statsPods, StringComparison.Ordinal);
        Assert.DoesNotContain("registeredVisits", frontendStats, StringComparison.Ordinal);
        Assert.DoesNotContain("anonymousVisits", frontendStats, StringComparison.Ordinal);
        Assert.Contains("ip_hash", visitLog, StringComparison.Ordinal);
        Assert.Contains("IpHash =", visitProcessor, StringComparison.Ordinal);
        Assert.Contains("unique_viewer_estimate", stats, StringComparison.Ordinal);
        Assert.Contains("human_verified_reads", stats, StringComparison.Ordinal);
        Assert.Contains("TotalReads", outputs, StringComparison.Ordinal);
        Assert.Contains("UniqueViewerKeyEstimate", outputs, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SubmitAsync_ReplayedProof_DoesNotWriteSecondEvent()
    {
        var fixture = CreateFixture();
        var challenge = await fixture.Service.CreateChallengeAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadChallengeRequest("site", "home", null));
        Assert.NotNull(challenge);
        fixture.Time.Advance(TimeSpan.FromSeconds(9));
        var request = new HumanReadSubmitRequest(challenge!.Token, "site", "home", null, 9000);

        var first = await fixture.Service.SubmitAsync(BuildBrowserContext(fixture.Services), request);
        var second = await fixture.Service.SubmitAsync(BuildBrowserContext(fixture.Services), request);

        Assert.True(first.Counted);
        Assert.False(second.Counted);
        Assert.True(fixture.Channel.Reader.TryRead(out _));
        Assert.False(fixture.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_TamperedRoute_DoesNotWriteEvent()
    {
        var fixture = CreateFixture();
        var challenge = await fixture.Service.CreateChallengeAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadChallengeRequest("article", "article:42", 42));
        Assert.NotNull(challenge);
        fixture.Time.Advance(TimeSpan.FromSeconds(9));

        var submit = await fixture.Service.SubmitAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadSubmitRequest(challenge!.Token, "article", "article:43", 43, 9000));

        Assert.False(submit.Counted);
        Assert.False(fixture.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task CreateChallengeAsync_DirectApiContextWithoutBrowserHeaders_IsRejected()
    {
        var fixture = CreateFixture();
        var context = new DefaultHttpContext { RequestServices = fixture.Services };
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("localhost");
        context.Request.Headers.UserAgent = "curl/8";

        var challenge = await fixture.Service.CreateChallengeAsync(
            context,
            new HumanReadChallengeRequest("site", "home", null));

        Assert.Null(challenge);
    }

    [Fact]
    public async Task SubmitAsync_DwellShorterThanChallengeMinimum_IsRejected()
    {
        var fixture = CreateFixture();
        var challenge = await fixture.Service.CreateChallengeAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadChallengeRequest("site", "home", null));
        Assert.NotNull(challenge);
        fixture.Time.Advance(TimeSpan.FromSeconds(3));

        var submit = await fixture.Service.SubmitAsync(
            BuildBrowserContext(fixture.Services),
            new HumanReadSubmitRequest(challenge!.Token, "site", "home", null, 3000));

        Assert.False(submit.Counted);
        Assert.False(fixture.Channel.Reader.TryRead(out _));
    }

    private static TestFixture CreateFixture()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = "0123456789abcdef0123456789abcdef",
                ["HumanReadProof:Mode"] = "enforce"
            })
            .Build();
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(config);
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns(Environments.Development);
        services.AddSingleton(env);
        ServiceProvider provider = services.BuildServiceProvider();
        var cache = new MemoryLeaseCache();
        var channel = new VisitLogChannel();
        var time = new MutableTimeProvider(DateTimeOffset.Parse("2026-05-13T00:00:00Z"));
        var service = new HumanReadProofService(config, cache, channel, time, NullLogger<HumanReadProofService>.Instance);
        return new TestFixture(service, provider, channel, time);
    }

    private static DefaultHttpContext BuildBrowserContext(IServiceProvider services)
    {
        var context = new DefaultHttpContext { RequestServices = services };
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("localhost");
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");
        context.Request.Headers.UserAgent = "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36";
        context.Request.Headers["X-Fsus-Device-Fp"] = "0123456789abcdef0123456789abcdef";
        context.Request.Headers["Sec-Fetch-Site"] = "same-origin";
        context.Request.Headers["Sec-Fetch-Mode"] = "cors";
        context.Request.Headers["Sec-Fetch-Dest"] = "empty";
        context.Request.Headers.Referer = "http://localhost/article/42";
        return context;
    }

    private static DefaultHttpContext BuildAuthenticatedBrowserContext(IServiceProvider services, int userId)
    {
        var context = BuildBrowserContext(services);
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, userId.ToString())],
            "test"));
        return context;
    }

    private sealed record TestFixture(
        IHumanReadProofService Service,
        IServiceProvider Services,
        VisitLogChannel Channel,
        MutableTimeProvider Time);

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan value) => _now = _now.Add(value);
    }

    private sealed class MemoryLeaseCache : IUnifiedCache
    {
        private readonly HashSet<string> _leases = new(StringComparer.Ordinal);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            return Task.FromResult(_leases.Add($"{policyId}:{identity}"));
        }

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<T>));
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<byte[]>));
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<ReadOnlyMemory<byte>>));
        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult<string?>(null);
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => Task.FromResult(0L);
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<T>));
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult<IAsyncDisposable>(NullDisposable.Instance);
        public string BuildKey(CachePolicyId policyId, string identity, string? version = null) => $"{policyId}:{identity}";

        private sealed class NullDisposable : IAsyncDisposable
        {
            public static readonly NullDisposable Instance = new();
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
