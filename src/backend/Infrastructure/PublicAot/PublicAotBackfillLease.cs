using System.Globalization;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotBackfillLeaseMode
{
    Local = 0,
    Redis = 1
}

public sealed record PublicAotBackfillLeaseOptions(
    PublicAotBackfillLeaseMode Mode,
    TimeSpan LeaseTtl,
    TimeSpan RenewInterval)
{
    public static PublicAotBackfillLeaseOptions FromEnvironment()
    {
        string runtimeMode = Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_MODE")
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUNTIME_MODE")
            ?? "single";
        return ForRuntimeMode(runtimeMode);
    }

    internal static PublicAotBackfillLeaseOptions ForRuntimeMode(string? runtimeMode)
    {
        PublicAotBackfillLeaseMode mode = string.Equals(runtimeMode?.Trim(), "single", StringComparison.OrdinalIgnoreCase)
            ? PublicAotBackfillLeaseMode.Local
            : PublicAotBackfillLeaseMode.Redis;
        return new PublicAotBackfillLeaseOptions(
            mode,
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(10));
    }
}

public sealed class PublicAotBackfillLease(
    ICacheLeaseStore leaseStore,
    PublicAotBackfillLeaseOptions options,
    ILogger<PublicAotBackfillLease> logger) : IPublicAotBackfillLease
{
    public async ValueTask<IPublicAotBackfillLeaseHandle?> TryAcquireAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateOptions(options);
        string identity = BuildIdentity(request);
        if (options.Mode == PublicAotBackfillLeaseMode.Local)
        {
            return new LocalHandle(options.RenewInterval);
        }

        string ownerToken = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        bool acquired = await leaseStore.TryAcquireLeaseAsync(
                CachePolicyId.PublicAotBackfillLease,
                identity,
                ownerToken,
                options.LeaseTtl,
                cancellationToken)
            .ConfigureAwait(false);
        return acquired
            ? new RedisHandle(
                leaseStore,
                identity,
                ownerToken,
                options.LeaseTtl,
                options.RenewInterval,
                logger)
            : null;
    }

    internal static string BuildIdentity(PublicAotBackfillRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RouteKey))
        {
            throw new ArgumentException("Public AOT backfill lease route key must be non-empty.", nameof(request));
        }
        if (string.IsNullOrWhiteSpace(request.FrontendAssetVersion))
        {
            throw new ArgumentException("Public AOT backfill lease frontend asset version must be non-empty.", nameof(request));
        }

        return string.Join(
            ':',
            ((int)request.Kind).ToString(CultureInfo.InvariantCulture),
            Uri.EscapeDataString(request.RouteKey),
            Uri.EscapeDataString(request.FrontendAssetVersion),
            Uri.EscapeDataString(request.TestSessionId ?? "default"));
    }

    private static void ValidateOptions(PublicAotBackfillLeaseOptions value)
    {
        if (value.LeaseTtl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(value), "Public AOT backfill lease TTL must be positive.");
        }
        if (value.RenewInterval <= TimeSpan.Zero || value.RenewInterval >= value.LeaseTtl)
        {
            throw new ArgumentOutOfRangeException(nameof(value), "Public AOT backfill lease renewal must be positive and shorter than its TTL.");
        }
    }

    private sealed class LocalHandle(TimeSpan renewInterval) : IPublicAotBackfillLeaseHandle
    {
        public TimeSpan RenewInterval => renewInterval;

        public Task<bool> RenewAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class RedisHandle(
        ICacheLeaseStore leaseStore,
        string identity,
        string ownerToken,
        TimeSpan leaseTtl,
        TimeSpan renewInterval,
        ILogger logger) : IPublicAotBackfillLeaseHandle
    {
        private int _disposed;

        public TimeSpan RenewInterval => renewInterval;

        public Task<bool> RenewAsync(CancellationToken cancellationToken = default)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
            return leaseStore.TryRenewLeaseAsync(
                CachePolicyId.PublicAotBackfillLease,
                identity,
                ownerToken,
                leaseTtl,
                cancellationToken);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            try
            {
                _ = await leaseStore.TryReleaseLeaseAsync(
                        CachePolicyId.PublicAotBackfillLease,
                        identity,
                        ownerToken,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "public-aot-backfill-lease-release-failed {LeaseIdentity}", identity);
            }
        }
    }
}
