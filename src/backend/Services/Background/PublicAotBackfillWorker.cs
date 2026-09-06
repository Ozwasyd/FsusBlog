using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Background;

public sealed class PublicAotBackfillWorker(
    PublicAotBackfillScheduler scheduler,
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<PublicAotBackfillWorker> logger,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseCommitGuard activeReleaseCommitGuard,
    IPublicAotBackfillLease backfillLease,
    PublicAotSsrRuntimeState runtimeState) : BackgroundService
{
    private static readonly TimeSpan s_standbyDelay = TimeSpan.FromSeconds(5);

    private readonly int _backfillConcurrency = NormalizeBackfillConcurrency(
        configuration.GetValue<int?>("PublicAot:BackfillConcurrency") ?? 1);

    internal int BackfillConcurrency => _backfillConcurrency;

    internal static int NormalizeBackfillConcurrency(int value)
        => Math.Clamp(value, 1, 8);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            bool ran = await workerLease.TryRunAsLeaderAsync("public-aot-backfill-worker",
                    async token =>
                    {
                        Task[] workers = Enumerable.Range(0, _backfillConcurrency)
                            .Select(_ => RunBackfillLoopAsync(token))
                            .ToArray();

                        await Task.WhenAll(workers).ConfigureAwait(false);
                    },
                    stoppingToken)
                .ConfigureAwait(false);
            if (!ran)
            {
                await Task.Delay(s_standbyDelay, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    private async Task RunBackfillLoopAsync(CancellationToken stoppingToken)
    {
        scheduler.ReplayDurablePending();
        await foreach (PublicAotBackfillRequest request in scheduler.ReadAllAsync(stoppingToken))
        {
            await ProcessRequestAsync(request, stoppingToken);
        }
    }

    private async Task ProcessRequestAsync(PublicAotBackfillRequest request, CancellationToken stoppingToken)
    {
        scheduler.Begin(request);
        bool committed = false;
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ITestSessionKeyScope testSessionKeyScope = scope.ServiceProvider.GetRequiredService<ITestSessionKeyScope>();
        using IDisposable testSessionScope = testSessionKeyScope.BeginScope(request.TestSessionId);
        try
        {
            if (!scheduler.ShouldProcess(request))
            {
                committed = true;
                return;
            }

            if (runtimeState.IsRouteQuarantined(request))
            {
                runtimeState.RecordBackfillDropped(request, "route-quarantined-before-lease", scheduler.InFlightCount);
                scheduler.RetainDurablePending(request, "route-quarantined-before-lease");
                return;
            }

            IPublicAotBackfillLeaseHandle? lease;
            try
            {
                lease = await backfillLease.TryAcquireAsync(request, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                runtimeState.RecordBackfillDropped(request, "lease-unavailable", scheduler.InFlightCount);
                scheduler.RetainDurablePending(request, "lease-unavailable");
                logger.LogWarning(ex, "Public AOT backfill lease unavailable: {Kind} {RouteKey}", request.Kind, request.RouteKey);
                return;
            }

            if (lease is null)
            {
                runtimeState.RecordBackfillDropped(request, "lease-contended", scheduler.InFlightCount);
                logger.LogDebug("Public AOT backfill lease contended: {Kind} {RouteKey}", request.Kind, request.RouteKey);
                return;
            }

            await using (lease)
            {
                var leaseState = new LeaseRenewalState();
                using CancellationTokenSource leaseCancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                Task renewal = RenewLeaseUntilStoppedAsync(request, lease, leaseCancellation, leaseState);
                IPublicAotBackfillGenerator generator = scope.ServiceProvider.GetRequiredService<IPublicAotBackfillGenerator>();
                try
                {
                    try
                    {
                        await generator.GenerateAndStoreAsync(
                            request,
                            leaseCancellation.Token,
                            beforeCommit: commitToken => EnsureCommitAllowedAsync(lease, leaseState, commitToken));
                    }
                    catch (OperationCanceledException) when (leaseState.IsLost)
                    {
                        throw new PublicAotBackfillLeaseLostException();
                    }
                }
                finally
                {
                    await leaseCancellation.CancelAsync().ConfigureAwait(false);
                    await renewal.ConfigureAwait(false);
                }
            }
            logger.LogInformation("Public AOT backfill completed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
            committed = true;
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            scheduler.RetainDurablePending(request, "cancelled");
        }
        catch (PublicAotBackfillLeaseLostException)
        {
            runtimeState.RecordBackfillDropped(request, "lease-lost", scheduler.InFlightCount);
            scheduler.RetainDurablePending(request, "lease-lost");
            logger.LogWarning("Public AOT backfill lease lost before commit: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        catch (Exception ex)
        {
            scheduler.RetainDurablePending(request, "worker-exception");
            logger.LogError(ex, "Public AOT backfill failed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        finally
        {
            scheduler.Complete(request, committed);
        }
    }

    private async Task RenewLeaseUntilStoppedAsync(
        PublicAotBackfillRequest request,
        IPublicAotBackfillLeaseHandle lease,
        CancellationTokenSource leaseCancellation,
        LeaseRenewalState leaseState)
    {
        try
        {
            using PeriodicTimer timer = new(lease.RenewInterval);
            while (await timer.WaitForNextTickAsync(leaseCancellation.Token).ConfigureAwait(false))
            {
                if (await lease.RenewAsync(leaseCancellation.Token).ConfigureAwait(false))
                {
                    continue;
                }

                logger.LogWarning("Public AOT backfill lease renewal rejected: {Kind} {RouteKey}", request.Kind, request.RouteKey);
                leaseState.MarkLost();
                await leaseCancellation.CancelAsync().ConfigureAwait(false);
                return;
            }
        }
        catch (OperationCanceledException) when (leaseCancellation.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Public AOT backfill lease renewal failed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
            leaseState.MarkLost();
            await leaseCancellation.CancelAsync().ConfigureAwait(false);
        }
    }

    private async Task EnsureCommitAllowedAsync(
        IPublicAotBackfillLeaseHandle lease,
        LeaseRenewalState leaseState,
        CancellationToken cancellationToken)
    {
        await activeReleaseCommitGuard.EnsureCurrentAsync(cancellationToken).ConfigureAwait(false);
        if (await lease.RenewAsync(cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        leaseState.MarkLost();
        throw new PublicAotBackfillLeaseLostException();
    }

    private sealed class LeaseRenewalState
    {
        private int _lost;

        public bool IsLost => Volatile.Read(ref _lost) == 1;

        public void MarkLost() => Interlocked.Exchange(ref _lost, 1);
    }

    private sealed class PublicAotBackfillLeaseLostException : Exception;
}
