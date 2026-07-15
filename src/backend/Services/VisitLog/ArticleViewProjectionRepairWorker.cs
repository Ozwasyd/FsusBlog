using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Services.VisitLog;

/// <summary>
/// Compatibility shell for deployments that still construct the retired
/// event-log repair worker. Runtime registration was removed with the
/// aggregate-only read pipeline; no event table is read or recreated.
/// </summary>
public sealed class ArticleViewProjectionRepairWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleViewProjectionRepairWorker> logger,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseTransactionalCommitGuard transactionalCommitGuard,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _ = scopeFactory;
        _ = timeProvider;
        _ = transactionalCommitGuard;
        _ = activeReleaseCommitGuard;
        await workerLease.TryRunAsLeaderAsync(
            "article-view-projection-repair-worker",
            _ =>
            {
                logger.LogInformation("article-view-projection-repair-retired aggregate-only=true");
                return Task.CompletedTask;
            },
            stoppingToken).ConfigureAwait(false);
    }

    internal Task<int> ReconcileOnceAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(0);
    }
}
