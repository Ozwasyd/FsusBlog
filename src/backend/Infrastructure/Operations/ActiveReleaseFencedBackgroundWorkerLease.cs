using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IActiveReleaseExecutionContextAccessor
{
    ActiveReleaseExecutionTicket? Current { get; }

    IDisposable Push(ActiveReleaseExecutionTicket ticket);
}

public sealed class ActiveReleaseExecutionContextAccessor : IActiveReleaseExecutionContextAccessor
{
    private readonly AsyncLocal<Holder?> _current = new();

    public ActiveReleaseExecutionTicket? Current => _current.Value?.Ticket;

    public IDisposable Push(ActiveReleaseExecutionTicket ticket)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        ActiveReleaseExecutionTicket? previous = _current.Value?.Ticket;
        if (_current.Value is { } current)
        {
            current.Ticket = null;
        }
        _current.Value = new Holder(ticket);
        return new Scope(this, previous);
    }

    private sealed class Holder(ActiveReleaseExecutionTicket? ticket)
    {
        public ActiveReleaseExecutionTicket? Ticket { get; set; } = ticket;
    }

    private sealed class Scope(
        ActiveReleaseExecutionContextAccessor owner,
        ActiveReleaseExecutionTicket? previous) : IDisposable
    {
        private ActiveReleaseExecutionContextAccessor? _owner = owner;

        public void Dispose()
        {
            ActiveReleaseExecutionContextAccessor? current = Interlocked.Exchange(ref _owner, null);
            if (current is not null)
            {
                if (current._current.Value is { } holder)
                {
                    holder.Ticket = null;
                }
                current._current.Value = previous is null ? null : new Holder(previous);
            }
        }
    }
}

public interface IActiveReleaseCommitGuard
{
    Task EnsureCurrentAsync(CancellationToken cancellationToken = default);

    Task EnsureCurrentAsync(ActiveReleaseExecutionTicket ticket, CancellationToken cancellationToken = default);
}

public sealed class ActiveReleaseCommitGuard(
    IActiveReleaseFence fence,
    IActiveReleaseExecutionContextAccessor executionContext) : IActiveReleaseCommitGuard
{
    public Task EnsureCurrentAsync(CancellationToken cancellationToken = default)
    {
        ActiveReleaseExecutionTicket ticket = executionContext.Current
            ?? throw new InvalidOperationException("No active release execution ticket is present for this commit boundary.");
        return EnsureCurrentAsync(ticket, cancellationToken);
    }

    public async Task EnsureCurrentAsync(
        ActiveReleaseExecutionTicket ticket,
        CancellationToken cancellationToken = default)
    {
        if (!await fence.IsCurrentAsync(ticket, forceStoreRead: true, cancellationToken).ConfigureAwait(false))
        {
            throw new ActiveReleaseFenceLostException(ticket.ReleaseId, ticket.Slot, ticket.Generation);
        }
    }
}

public sealed class ActiveReleaseFenceLostException(string releaseId, string slot, long generation)
    : InvalidOperationException($"Active release fence was lost by {releaseId}/{slot} generation {generation}.");

public sealed class ActiveReleaseFencedBackgroundWorkerLease(
    IUnifiedCache cache,
    IActiveReleaseFence activeReleaseFence,
    IActiveReleaseExecutionContextAccessor executionContext,
    DeploymentRuntimeState deploymentRuntime,
    ILogger<ActiveReleaseFencedBackgroundWorkerLease> logger,
    BackgroundWorkerLeaseOptions options,
    TimeProvider timeProvider) : IBackgroundWorkerLease
{
    public async Task<bool> TryRunAsLeaderAsync(
        string workerName,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workerName);
        ArgumentNullException.ThrowIfNull(action);
        ValidateOptions(options);

        if (!deploymentRuntime.TryBeginBackgroundClaim(out IDisposable? deploymentClaim))
        {
            ActiveReleaseFenceMetrics.RecordEligibility("rejected", "deployment_not_active");
            return false;
        }

        using (deploymentClaim)
        {
            ActiveReleaseExecutionTicket? ticket = await activeReleaseFence
                .TryCaptureExecutionTicketAsync(cancellationToken)
                .ConfigureAwait(false);
            if (ticket is null)
            {
                return false;
            }

            string identity = NormalizeWorkerIdentity(workerName);
            string owner = ticket.LeaseOwner;
            bool acquired;
            try
            {
                acquired = await AcquireOrRenewAsync(identity, owner, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "active-release-worker-lease-acquire-failed {WorkerIdentity}", identity);
                return false;
            }

            if (!acquired)
            {
                return false;
            }

            using IDisposable executionScope = executionContext.Push(ticket);
            using CancellationTokenSource fencedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Task renewal = RenewUntilStoppedAsync(identity, owner, ticket, fencedCancellation);
            try
            {
                await action(fencedCancellation.Token).ConfigureAwait(false);
                return await activeReleaseFence
                    .IsCurrentAsync(ticket, forceStoreRead: true, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (fencedCancellation.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                return false;
            }
            finally
            {
                await StopRenewalAsync(fencedCancellation, renewal).ConfigureAwait(false);
            }
        }
    }

    private async Task<bool> AcquireOrRenewAsync(
        string identity,
        string owner,
        CancellationToken cancellationToken)
    {
        if (await cache.TryAcquireLeaseAsync(
                CachePolicyId.BackgroundWorkerLease,
                identity,
                owner,
                options.LeaseTtl,
                cancellationToken).ConfigureAwait(false))
        {
            return true;
        }

        return await cache.TrySetStringIfValueAsync(
                CachePolicyId.BackgroundWorkerLease,
                identity,
                owner,
                identity,
                owner,
                options.LeaseTtl,
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task RenewUntilStoppedAsync(
        string identity,
        string owner,
        ActiveReleaseExecutionTicket ticket,
        CancellationTokenSource fencedCancellation)
    {
        try
        {
            using PeriodicTimer timer = new(options.RenewInterval, timeProvider);
            while (await timer.WaitForNextTickAsync(fencedCancellation.Token).ConfigureAwait(false))
            {
                if (!await activeReleaseFence
                    .IsCurrentAsync(ticket, forceStoreRead: true, fencedCancellation.Token)
                    .ConfigureAwait(false))
                {
                    logger.LogWarning(
                        "active-release-worker-fence-lost {WorkerIdentity} generation={Generation}",
                        identity,
                        ticket.Generation);
                    await fencedCancellation.CancelAsync().ConfigureAwait(false);
                    return;
                }

                bool renewed = await cache.TrySetStringIfValueAsync(
                        CachePolicyId.BackgroundWorkerLease,
                        identity,
                        owner,
                        identity,
                        owner,
                        options.LeaseTtl,
                        fencedCancellation.Token)
                    .ConfigureAwait(false);
                if (!renewed)
                {
                    logger.LogWarning("active-release-worker-lease-lost {WorkerIdentity}", identity);
                    await fencedCancellation.CancelAsync().ConfigureAwait(false);
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (fencedCancellation.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "active-release-worker-lease-renew-failed {WorkerIdentity}", identity);
            await fencedCancellation.CancelAsync().ConfigureAwait(false);
        }
    }

    private static async Task StopRenewalAsync(CancellationTokenSource cancellation, Task renewal)
    {
        await cancellation.CancelAsync().ConfigureAwait(false);
        try
        {
            await renewal.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
    }

    private static string NormalizeWorkerIdentity(string workerName)
        => $"background:{TextHelpers.LowerTrimmed(workerName) ?? string.Empty}";

    private static void ValidateOptions(BackgroundWorkerLeaseOptions leaseOptions)
    {
        if (leaseOptions.LeaseTtl <= TimeSpan.Zero
            || leaseOptions.RenewInterval <= TimeSpan.Zero
            || leaseOptions.RenewInterval >= leaseOptions.LeaseTtl)
        {
            throw new ArgumentOutOfRangeException(
                nameof(leaseOptions),
                "Active release worker lease TTL must be positive and longer than its renewal interval.");
        }
    }
}
