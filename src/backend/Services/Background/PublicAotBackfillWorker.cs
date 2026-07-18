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
    IActiveReleaseCommitGuard activeReleaseCommitGuard) : BackgroundService
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
        await foreach (PublicAotBackfillRequest request in scheduler.ReadAllAsync(stoppingToken))
        {
            await ProcessRequestAsync(request, stoppingToken);
        }
    }

    private async Task ProcessRequestAsync(PublicAotBackfillRequest request, CancellationToken stoppingToken)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ITestSessionKeyScope testSessionKeyScope = scope.ServiceProvider.GetRequiredService<ITestSessionKeyScope>();
        using IDisposable testSessionScope = testSessionKeyScope.BeginScope(request.TestSessionId);
        try
        {
            IPublicAotBackfillGenerator generator = scope.ServiceProvider.GetRequiredService<IPublicAotBackfillGenerator>();
            await generator.GenerateAndStoreAsync(
                request,
                stoppingToken,
                beforeCommit: commitToken => activeReleaseCommitGuard.EnsureCurrentAsync(commitToken));
            logger.LogInformation("Public AOT backfill completed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Public AOT backfill failed: {Kind} {RouteKey}", request.Kind, request.RouteKey);
        }
        finally
        {
            scheduler.Complete(request);
        }
    }
}
