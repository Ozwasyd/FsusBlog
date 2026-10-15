using System.Collections.Concurrent;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed record ArticleBodyRepairRequest(int ArticleId, string Source, int Attempt = 0);

public sealed class ArticleBodyRepairQueue
{
    private const int Capacity = 256;
    private readonly Lock _admissionGate = new();
    private readonly ConcurrentDictionary<int, byte> _pending = new();
    private readonly Channel<ArticleBodyRepairRequest> _channel = Channel.CreateBounded<ArticleBodyRepairRequest>(
        new BoundedChannelOptions(Capacity)
        {
            // TryWrite must reject a full queue so failed admission releases the pending ID.
            // DropWrite reports success even when it discards the request; Wait never blocks TryWrite.
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });

    public int PendingCount
    {
        get
        {
            lock (_admissionGate)
            {
                return _pending.Count;
            }
        }
    }

    public bool TrySchedule(int articleId, string source)
        => TrySchedule(new ArticleBodyRepairRequest(articleId, NormalizeSource(source)));

    internal IAsyncEnumerable<ArticleBodyRepairRequest> ReadAllAsync(CancellationToken cancellationToken)
        => _channel.Reader.ReadAllAsync(cancellationToken);

    internal void Complete(int articleId)
    {
        lock (_admissionGate)
        {
            _pending.TryRemove(articleId, out _);
        }
    }

    internal bool TryRetry(ArticleBodyRepairRequest request)
        => TrySchedule(request with
        {
            Attempt = request.Attempt + 1
        });

    private bool TrySchedule(ArticleBodyRepairRequest request)
    {
        if (request.ArticleId <= 0)
        {
            return false;
        }

        bool admitted;
        // Deduplication must not observe an admission that will subsequently be rejected.
        lock (_admissionGate)
        {
            if (!_pending.TryAdd(request.ArticleId, 0))
            {
                return true;
            }

            admitted = _channel.Writer.TryWrite(request);
            if (!admitted)
            {
                _pending.TryRemove(request.ArticleId, out _);
            }
        }

        FsusObservability.RecordOperation("article_body", "repair_queue", admitted ? "queued" : "full", TimeSpan.Zero);
        return admitted;
    }

    private static string NormalizeSource(string source)
        => source switch
        {
            "article-detail-cache" => source,
            "article-detail-db" => source,
            "article-detail-aeds" => source,
            "public-aot" => source,
            "public-hot-read" => source,
            "search-index" => source,
            _ => "unknown"
        };
}

public sealed class ArticleBodyRepairService(
    ISqlSugarClient db,
    ICacheInvalidationDispatcher cacheInvalidation,
    IPublicAotInvalidationService publicAotInvalidation,
    ArticleMutationProjectionInvalidator projections,
    ISearchIndexService searchIndex,
    ILogger<ArticleBodyRepairService> logger)
{
    public async Task RepairAsync(ArticleBodyRepairRequest request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int repaired = await db.Ado.ExecuteCommandAsync(
            $$"""
            INSERT INTO article_body (article_id, markdown_content, updated_at)
            SELECT article.id, block.markdown_content, NOW()
            FROM article
            JOIN article_publication publication
              ON publication.id = article.current_publication_id
             AND publication.article_id = article.id
            JOIN article_revision revision
              ON revision.id = publication.article_revision_id
             AND revision.article_id = article.id
            JOIN article_revision_content_block block ON block.id = revision.content_block_id
            WHERE article.id = @ArticleId
              AND article.isdeleted = false
              AND article.status = {{(int)ArticleStatus.Published}}
              AND article.current_revision_id = publication.article_revision_id
              AND revision.content_block_id > 0
              AND block.markdown_content IS NOT NULL
              AND btrim(block.markdown_content) <> ''
            ON CONFLICT (article_id) DO UPDATE
            SET markdown_content = EXCLUDED.markdown_content,
                updated_at = EXCLUDED.updated_at
            WHERE article_body.markdown_content IS NULL
               OR btrim(article_body.markdown_content) = '';
            """,
            new SugarParameter("@ArticleId", request.ArticleId)).ConfigureAwait(false);

        cancellationToken.ThrowIfCancellationRequested();
        int bodyAvailable = repaired > 0
            ? 1
            : await db.Ado.GetIntAsync(
                $$"""
                SELECT COUNT(*)
                FROM article
                JOIN article_publication publication
                  ON publication.id = article.current_publication_id
                 AND publication.article_id = article.id
                JOIN article_revision revision
                  ON revision.id = publication.article_revision_id
                 AND revision.article_id = article.id
                JOIN article_revision_content_block block ON block.id = revision.content_block_id
                JOIN article_body body ON body.article_id = article.id
                WHERE article.id = @ArticleId
                  AND article.isdeleted = false
                  AND article.status = {{(int)ArticleStatus.Published}}
                  AND article.current_revision_id = publication.article_revision_id
                  AND revision.content_block_id > 0
                  AND block.markdown_content IS NOT NULL
                  AND btrim(block.markdown_content) <> ''
                  AND body.markdown_content = block.markdown_content;
                """,
                new SugarParameter("@ArticleId", request.ArticleId)).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (bodyAvailable == 0)
        {
            logger.LogWarning(
                "article_body_repair_unresolved {ArticleId} {Source}",
                request.ArticleId,
                request.Source);
            FsusObservability.RecordOperation("article_body", "repair", "unresolved", TimeSpan.Zero);
            return;
        }

        var failures = new List<Exception>();
        string mutationId = $"article-repair:{Guid.CreateVersion7():N}";
        await RunAsync(() => projections.RevokeArticleAsync(request.ArticleId, cancellationToken), failures, cancellationToken).ConfigureAwait(false);
        await RunAsync(
                () => cacheInvalidation.InvalidateArticleBodyRepairAsync(request.ArticleId, mutationId, cancellationToken),
                failures,
                cancellationToken)
            .ConfigureAwait(false);
        await RunAsync(
                () => publicAotInvalidation.InvalidateRouteAsync(
                    PublicPageId.ArticleDetail,
                    $"article:{request.ArticleId}",
                    cancellationToken),
                failures,
                cancellationToken)
            .ConfigureAwait(false);
        await RunAsync(() => searchIndex.AddOrUpdateIndexAsync(new Article { Id = request.ArticleId }), failures, cancellationToken).ConfigureAwait(false);
        await RunAsync(() => projections.GenerateDetailAsync(request.ArticleId, cancellationToken), failures, cancellationToken).ConfigureAwait(false);
        await RunAsync(
                async () =>
                {
                    await projections.EnsurePublicHotUpdateQueuedAsync(request.ArticleId, "article-body-repaired")
                        .ConfigureAwait(false);
                },
                failures,
                cancellationToken)
            .ConfigureAwait(false);

        if (failures.Count > 0)
        {
            throw new AggregateException("article_body_repair_rebuild_failed", failures);
        }

        logger.LogInformation(
            "article_body_repair_completed {ArticleId} {Source} {Attempt}",
            request.ArticleId,
            request.Source,
            request.Attempt);
        FsusObservability.RecordOperation("article_body", "repair", "completed", TimeSpan.Zero);
    }

    private static async Task RunAsync(
        Func<Task> operation,
        List<Exception> failures,
        CancellationToken cancellationToken)
    {
        try
        {
            await operation().ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            failures.Add(ex);
        }
    }
}

public sealed class ArticleBodyRepairWorker(
    ArticleBodyRepairQueue queue,
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleBodyRepairWorker> logger) : BackgroundService
{
    private const int MaxAttempts = 3;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (ArticleBodyRepairRequest request in queue.ReadAllAsync(stoppingToken))
        {
            bool retry = false;
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                var repair = scope.ServiceProvider.GetRequiredService<ArticleBodyRepairService>();
                await repair.RepairAsync(request, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                retry = request.Attempt + 1 < MaxAttempts;
                logger.LogWarning(
                    ex,
                    "article_body_repair_failed {ArticleId} {Source} {Attempt} {Retry}",
                    request.ArticleId,
                    request.Source,
                    request.Attempt,
                    retry);
                FsusObservability.RecordOperation("article_body", "repair", retry ? "retry" : "failed", TimeSpan.Zero);
            }
            finally
            {
                queue.Complete(request.ArticleId);
            }

            if (retry && !stoppingToken.IsCancellationRequested)
            {
                queue.TryRetry(request);
            }
        }
    }
}
