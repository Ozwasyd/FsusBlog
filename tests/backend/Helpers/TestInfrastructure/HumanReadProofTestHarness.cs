using System.Net;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal sealed class HumanReadProofTestHarness : IAsyncDisposable
{
    internal const string DefaultDeviceFingerprint = "0123456789abcdef0123456789abcdef";
    internal const string DefaultUserAgent = "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36";
    internal const string DefaultReferer = "http://localhost/article/42";

    private HumanReadProofTestHarness(
        HumanReadProofService service,
        ServiceProvider services,
        VisitLogChannel channel,
        MutableTimeProvider time,
        RecordingLeaseCache cache)
    {
        Service = service;
        Services = services;
        Channel = channel;
        Time = time;
        Cache = cache;
    }

    internal HumanReadProofService Service { get; }
    internal ServiceProvider Services { get; }
    internal VisitLogChannel Channel { get; }
    internal MutableTimeProvider Time { get; }
    internal RecordingLeaseCache Cache { get; }

    internal static HumanReadProofTestHarness Create(
        IReadOnlyDictionary<string, string?>? overrides = null,
        DateTimeOffset? now = null,
        ILogger<HumanReadProofService>? logger = null)
    {
        var settings = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["HumanReadProof:Mode"] = "enforce",
            ["HumanReadProof:SigningKey"] = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            ["HumanReadProof:Dedup:CurrentKeyEpoch"] = "7",
            ["HumanReadProof:Dedup:CurrentKey"] = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="
        };
        if (overrides is not null)
        {
            foreach ((string key, string? value) in overrides)
            {
                settings[key] = value;
            }
        }

        IConfigurationRoot configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(Environments.Production);
        ServiceProvider services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddSingleton<IWebHostEnvironment>(environment)
            .BuildServiceProvider();
        var cache = new RecordingLeaseCache();
        var channel = new VisitLogChannel();
        var time = new MutableTimeProvider(now ?? DateTimeOffset.Parse("2026-05-13T00:00:00Z"));
        var service = new HumanReadProofService(
            configuration,
            cache,
            channel,
            time,
            logger ?? NullLogger<HumanReadProofService>.Instance,
            environment);
        return new HumanReadProofTestHarness(service, services, channel, time, cache);
    }

    internal DefaultHttpContext CreateBrowserContext(
        string deviceFingerprint = DefaultDeviceFingerprint,
        string userAgent = DefaultUserAgent,
        string remoteIp = "127.0.0.1",
        string? origin = null,
        string? referer = DefaultReferer)
    {
        var context = new DefaultHttpContext { RequestServices = Services };
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("localhost");
        context.Connection.RemoteIpAddress = IPAddress.Parse(remoteIp);
        context.Request.Headers.UserAgent = userAgent;
        context.Request.Headers["X-Fsus-Device-Fp"] = deviceFingerprint;
        context.Request.Headers["Sec-Fetch-Site"] = "same-origin";
        context.Request.Headers["Sec-Fetch-Mode"] = "cors";
        context.Request.Headers["Sec-Fetch-Dest"] = "empty";
        if (origin is not null)
        {
            context.Request.Headers.Origin = origin;
        }

        if (referer is not null)
        {
            context.Request.Headers.Referer = referer;
        }

        return context;
    }

    internal DefaultHttpContext CreateAuthenticatedBrowserContext(int userId)
    {
        DefaultHttpContext context = CreateBrowserContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, userId.ToString(System.Globalization.CultureInfo.InvariantCulture))],
            "test"));
        return context;
    }

    public async ValueTask DisposeAsync()
    {
        await Services.DisposeAsync();
    }

    internal sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        internal void Advance(TimeSpan value) => _now = _now.Add(value);
    }

    internal sealed record LeaseAcquisition(CachePolicyId PolicyId, string Identity, TimeSpan Ttl, bool Acquired);

    internal sealed class RecordingLeaseCache : IUnifiedCache
    {
        private readonly object _gate = new();
        private readonly HashSet<string> _leases = new(StringComparer.Ordinal);
        private readonly List<LeaseAcquisition> _acquisitions = [];

        internal Exception? AcquireException { get; set; }

        internal IReadOnlyList<LeaseAcquisition> Acquisitions
        {
            get
            {
                lock (_gate)
                {
                    return [.. _acquisitions];
                }
            }
        }

        public Task<bool> TryAcquireLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
        {
            if (AcquireException is not null)
            {
                throw AcquireException;
            }

            lock (_gate)
            {
                bool acquired = _leases.Add($"{policyId}:{identity}");
                _acquisitions.Add(new LeaseAcquisition(policyId, identity, ttl, acquired));
                return Task.FromResult(acquired);
            }
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
            internal static readonly NullDisposable Instance = new();
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
