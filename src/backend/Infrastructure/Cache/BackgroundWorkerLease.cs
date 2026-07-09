using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface IBackgroundWorkerLease
{
    Task<bool> TryRunAsLeaderAsync(
        string workerName,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken = default);
}

public sealed record BackgroundWorkerLeaseOptions(
    TimeSpan LeaseTtl,
    TimeSpan RenewInterval,
    string NodeId);

public sealed class BackgroundWorkerLease(
    IUnifiedCache cache,
    ILogger<BackgroundWorkerLease> logger,
    BackgroundWorkerLeaseOptions options,
    TimeProvider timeProvider) : IBackgroundWorkerLease
{
    private readonly string _ownerValue = $"{NormalizeNodeId(options.NodeId)}:{Guid.NewGuid():N}";

    public async Task<bool> TryRunAsLeaderAsync(
        string workerName,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workerName);
        ArgumentNullException.ThrowIfNull(action);
        ValidateOptions(options);

        string identity = NormalizeWorkerIdentity(workerName);
        bool hasLeadership;
        try
        {
            hasLeadership = await AcquireOrRenewAsync(identity, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "background-worker-lease-acquire-failed {WorkerIdentity}", identity);
            return false;
        }

        if (!hasLeadership)
        {
            return false;
        }

        using CancellationTokenSource leaseCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task renewTask = RenewUntilStoppedAsync(identity, leaseCancellation);
        try
        {
            await action(leaseCancellation.Token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (leaseCancellation.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        finally
        {
            await StopRenewalAsync(leaseCancellation, renewTask).ConfigureAwait(false);
        }
    }

    private async Task<bool> AcquireOrRenewAsync(string identity, CancellationToken cancellationToken)
    {
        bool acquired = await cache.TryAcquireLeaseAsync(
                CachePolicyId.BackgroundWorkerLease,
                identity,
                _ownerValue,
                options.LeaseTtl,
                cancellationToken)
            .ConfigureAwait(false);
        if (acquired)
        {
            return true;
        }

        return await cache.TrySetStringIfValueAsync(
                CachePolicyId.BackgroundWorkerLease,
                identity,
                _ownerValue,
                identity,
                _ownerValue,
                options.LeaseTtl,
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task RenewUntilStoppedAsync(string identity, CancellationTokenSource leaseCancellation)
    {
        try
        {
            using PeriodicTimer timer = new(options.RenewInterval, timeProvider);
            while (await timer.WaitForNextTickAsync(leaseCancellation.Token).ConfigureAwait(false))
            {
                bool renewed = await cache.TrySetStringIfValueAsync(
                        CachePolicyId.BackgroundWorkerLease,
                        identity,
                        _ownerValue,
                        identity,
                        _ownerValue,
                        options.LeaseTtl,
                        leaseCancellation.Token)
                    .ConfigureAwait(false);
                if (!renewed)
                {
                    logger.LogWarning("background-worker-lease-lost {WorkerIdentity}", identity);
                    await leaseCancellation.CancelAsync().ConfigureAwait(false);
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (leaseCancellation.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "background-worker-lease-renew-failed {WorkerIdentity}", identity);
            await leaseCancellation.CancelAsync().ConfigureAwait(false);
        }
    }

    private static async Task StopRenewalAsync(CancellationTokenSource leaseCancellation, Task renewTask)
    {
        await leaseCancellation.CancelAsync().ConfigureAwait(false);
        try
        {
            await renewTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (leaseCancellation.IsCancellationRequested)
        {
        }
    }

    private static string NormalizeWorkerIdentity(string workerName)
        => $"background:{TextHelpers.LowerTrimmed(workerName) ?? string.Empty}";

    private static string NormalizeNodeId(string nodeId)
        => string.IsNullOrWhiteSpace(nodeId)
            ? $"{Environment.MachineName}:{Environment.ProcessId}"
            : nodeId.Trim();

    private static void ValidateOptions(BackgroundWorkerLeaseOptions leaseOptions)
    {
        if (leaseOptions.LeaseTtl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(leaseOptions), "Background worker lease TTL must be positive.");
        }

        if (leaseOptions.RenewInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(leaseOptions), "Background worker lease renewal interval must be positive.");
        }

        if (leaseOptions.RenewInterval >= leaseOptions.LeaseTtl)
        {
            throw new ArgumentOutOfRangeException(nameof(leaseOptions), "Background worker lease renewal interval must be shorter than the TTL.");
        }
    }
}
