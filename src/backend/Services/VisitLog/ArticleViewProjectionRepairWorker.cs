using FsusBlog.Server.Infrastructure.Execution;
using SqlSugar;

namespace FsusBlog.Server.Services.VisitLog;

public sealed class ArticleViewProjectionRepairWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleViewProjectionRepairWorker> logger,
    TimeProvider timeProvider) : BackgroundService
{
    private static readonly TimeSpan ReconcileInterval = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(ReconcileInterval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await ReconcileOnceAsync(stoppingToken).ConfigureAwait(false);
            try
            {
                await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> ReconcileOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();

            int repaired = await dbGate.ExecuteAsync(
                "article-view-projection-reconcile",
                _ => db.Ado.ExecuteCommandAsync("""
                    UPDATE article AS a
                    SET views = projected.views
                    FROM (
                        SELECT article_id, COUNT(*)::integer AS views
                        FROM sys_visit_log
                        WHERE event_type = 'article_read'
                          AND article_id IS NOT NULL
                        GROUP BY article_id
                    ) AS projected
                    WHERE a.id = projected.article_id
                      AND a.isdeleted = false
                      AND a.views <> projected.views;
                    """),
                _ => Task.FromResult(0),
                cancellationToken).ConfigureAwait(false);

            if (repaired > 0)
            {
                logger.LogInformation("article-view-projection-reconciled {Count}", repaired);
            }

            return repaired;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return 0;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "article-view-projection-reconcile-failed");
            return 0;
        }
    }
}
