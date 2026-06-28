using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using SqlSugar;

namespace FsusBlog.Server.Services.VisitLog;

public sealed class ArticleViewProjectionRepairWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleViewProjectionRepairWorker> logger,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease) : BackgroundService
{
    private static readonly TimeSpan ReconcileInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan FullReconcileInterval = TimeSpan.FromDays(1);
    private const string ProjectionWatermarkKey = "article_view_projection_watermark";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(ReconcileInterval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await workerLease.TryRunAsLeaderAsync("article-view-projection-repair-worker", token => ReconcileOnceAsync(token), stoppingToken)
                .ConfigureAwait(false);
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
                async _ =>
                {
                    await EnsureWatermarkStoreAsync(db).ConfigureAwait(false);

                    SugarParameter[] keyParameters = [new("@ProjectionWatermarkKey", ProjectionWatermarkKey)];
                    int lastVisitLogId = await db.Ado.GetIntAsync("""
                        SELECT last_visit_log_id
                        FROM article_view_projection_watermark
                        WHERE id = @ProjectionWatermarkKey;
                        """, keyParameters).ConfigureAwait(false);

                    SugarParameter[] deltaParameters =
                    [
                        new("@LastVisitLogId", lastVisitLogId),
                    ];
                    int scannedRows = await db.Ado.GetIntAsync("""
                        SELECT COUNT(1)
                        FROM sys_visit_log
                        WHERE id > @LastVisitLogId
                          AND event_type = 'article_read'
                          AND article_id IS NOT NULL;
                        """, deltaParameters).ConfigureAwait(false);

                    int maxVisitLogId = await db.Ado.GetIntAsync("""
                        SELECT COALESCE(MAX(id), @LastVisitLogId)
                        FROM sys_visit_log
                        WHERE id > @LastVisitLogId;
                        """, deltaParameters).ConfigureAwait(false);

                    int incrementallyRepaired = await db.Ado.GetIntAsync("""
                        WITH changed_articles AS (
                            SELECT DISTINCT article_id
                            FROM sys_visit_log
                            WHERE id > @LastVisitLogId
                              AND event_type = 'article_read'
                              AND article_id IS NOT NULL
                        ),
                        projected AS (
                            SELECT
                                changed_articles.article_id,
                                (
                                    SELECT COUNT(*)::integer
                                    FROM sys_visit_log AS all_logs
                                    WHERE all_logs.event_type = 'article_read'
                                      AND all_logs.article_id = changed_articles.article_id
                                ) AS views
                            FROM changed_articles
                        ),
                        updated AS (
                            UPDATE article AS a
                            SET views = projected.views
                            FROM projected
                            WHERE a.id = projected.article_id
                              AND a.isdeleted = false
                              AND a.views <> projected.views
                            RETURNING a.id
                        )
                        SELECT COUNT(1)
                        FROM updated;
                        """, deltaParameters).ConfigureAwait(false);

                    await db.Ado.ExecuteCommandAsync("""
                        UPDATE article_view_projection_watermark
                        SET last_visit_log_id = @MaxVisitLogId,
                            updated_at_utc = @UpdatedAtUtc
                        WHERE id = @ProjectionWatermarkKey;
                        """, new SugarParameter[]
                        {
                            new("@ProjectionWatermarkKey", ProjectionWatermarkKey),
                            new("@MaxVisitLogId", Math.Max(lastVisitLogId, maxVisitLogId)),
                            new("@UpdatedAtUtc", timeProvider.GetUtcNow().UtcDateTime),
                        }).ConfigureAwait(false);

                    int fullRepaired = 0;
                    if (await ShouldRunFullReconcileAsync(db).ConfigureAwait(false))
                    {
                        fullRepaired = await RunFullReconcileAsync(db).ConfigureAwait(false);
                        await MarkFullReconcileAsync(db).ConfigureAwait(false);
                    }

                    logger.LogInformation(
                        "article-view-projection-reconcile scannedRows={ScannedRows} updatedArticles={UpdatedArticles} watermark={Watermark} fullUpdatedArticles={FullUpdatedArticles}",
                        scannedRows,
                        incrementallyRepaired,
                        Math.Max(lastVisitLogId, maxVisitLogId),
                        fullRepaired);

                    return incrementallyRepaired + fullRepaired;
                },
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

    private async Task EnsureWatermarkStoreAsync(ISqlSugarClient db)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE IF NOT EXISTS article_view_projection_watermark (
                id varchar(96) PRIMARY KEY,
                last_visit_log_id integer NOT NULL DEFAULT 0,
                last_full_reconcile_utc timestamp NULL,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );

            INSERT INTO article_view_projection_watermark (
                id,
                last_visit_log_id,
                last_full_reconcile_utc,
                updated_at_utc
            )
            SELECT
                @ProjectionWatermarkKey,
                COALESCE(MAX(id), 0),
                @LastFullReconcileUtc,
                @UpdatedAtUtc
            FROM sys_visit_log
            ON CONFLICT (id) DO NOTHING;
            """, new SugarParameter[]
            {
                new("@ProjectionWatermarkKey", ProjectionWatermarkKey),
                new("@LastFullReconcileUtc", now),
                new("@UpdatedAtUtc", now),
            }).ConfigureAwait(false);
    }

    private async Task<bool> ShouldRunFullReconcileAsync(ISqlSugarClient db)
    {
        DateTime cutoffUtc = timeProvider.GetUtcNow().UtcDateTime.Subtract(FullReconcileInterval);
        int shouldRun = await db.Ado.GetIntAsync("""
            SELECT CASE
                WHEN last_full_reconcile_utc IS NULL OR last_full_reconcile_utc <= @CutoffUtc THEN 1
                ELSE 0
            END
            FROM article_view_projection_watermark
            WHERE id = @ProjectionWatermarkKey;
            """, new SugarParameter[]
            {
                new("@ProjectionWatermarkKey", ProjectionWatermarkKey),
                new("@CutoffUtc", cutoffUtc),
            }).ConfigureAwait(false);

        return shouldRun > 0;
    }

    private async Task<int> RunFullReconcileAsync(ISqlSugarClient db)
        => await db.Ado.ExecuteCommandAsync("""
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
            """).ConfigureAwait(false);

    private async Task MarkFullReconcileAsync(ISqlSugarClient db)
        => await db.Ado.ExecuteCommandAsync("""
            UPDATE article_view_projection_watermark
            SET last_full_reconcile_utc = @LastFullReconcileUtc,
                updated_at_utc = @UpdatedAtUtc
            WHERE id = @ProjectionWatermarkKey;
            """, new SugarParameter[]
            {
                new("@ProjectionWatermarkKey", ProjectionWatermarkKey),
                new("@LastFullReconcileUtc", timeProvider.GetUtcNow().UtcDateTime),
                new("@UpdatedAtUtc", timeProvider.GetUtcNow().UtcDateTime),
            }).ConfigureAwait(false);
}
