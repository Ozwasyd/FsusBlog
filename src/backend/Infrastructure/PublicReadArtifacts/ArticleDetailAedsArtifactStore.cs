using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Threading.Channels;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public readonly record struct ArticleDetailAedsArtifact(ReadOnlyMemory<byte> Frame)
{
    public bool Found => !Frame.IsEmpty;
}

public interface IArticleDetailAedsArtifactStore
{
    Task<ArticleDetailAedsArtifact> TryReadAsync(int articleId, CancellationToken cancellationToken = default);
    Task WriteAsync(int articleId, ReadOnlyMemory<byte> frame, CancellationToken cancellationToken = default);
    Task RemoveAsync(int articleId, CancellationToken cancellationToken = default);
}

public interface IArticleDetailAedsArtifactBackfillScheduler
{
    bool TrySchedule(int articleId);
}

public interface IArticleDetailAedsArtifactProjector
{
    Task GenerateAndStoreAsync(int articleId, CancellationToken cancellationToken = default);
    Task RemoveAsync(int articleId, CancellationToken cancellationToken = default);
}

public interface IVersionedArticleDetailAedsArtifactProjector
{
    Task GenerateAndStoreAsync(
        int articleId,
        ArticleMutationVersionReference version,
        CancellationToken cancellationToken = default);
}

internal static class ArticleDetailProjectionCommitSequence
{
    internal static async Task PublishAsync(
        Func<Task> upsertProjection,
        Func<Task<bool>> verifyShadowParity,
        Func<Task> writeArtifact)
    {
        ArgumentNullException.ThrowIfNull(upsertProjection);
        ArgumentNullException.ThrowIfNull(verifyShadowParity);
        ArgumentNullException.ThrowIfNull(writeArtifact);

        await upsertProjection().ConfigureAwait(false);
        if (!await verifyShadowParity().ConfigureAwait(false))
        {
            throw new InvalidOperationException("public_article_projection_shadow_mismatch");
        }

        await writeArtifact().ConfigureAwait(false);
    }

    internal static async Task MarkUnavailableAsync(
        Func<Task> markProjectionUnavailable,
        Func<Task> removeArtifact)
    {
        ArgumentNullException.ThrowIfNull(markProjectionUnavailable);
        ArgumentNullException.ThrowIfNull(removeArtifact);

        await markProjectionUnavailable().ConfigureAwait(false);
        await removeArtifact().ConfigureAwait(false);
    }
}

internal static class PublicArticleProjectionBackfillPolicy
{
    internal static int ResolveParallelism(int itemCount, int ratePerSecond, int backgroundGateLimit)
        => Math.Clamp(Math.Min(ratePerSecond, backgroundGateLimit), 1, Math.Max(1, itemCount));

    internal static int ResolveBatchSize(int backgroundGateLimit)
        => Math.Clamp(backgroundGateLimit * 32, 32, 512);
}

public sealed record ArticleDetailAedsArtifactMaintenanceResult(
    int Scanned,
    int Rebuilt,
    int Removed,
    int Skipped,
    int Failed)
{
    public string ToDetail()
        => string.Create(
            CultureInfo.InvariantCulture,
            $"scanned={Scanned}, rebuilt={Rebuilt}, removed={Removed}, skipped={Skipped}, failed={Failed}");
}

public sealed record PublicArticleProjectionBackfillState(
    string State,
    int LastArticleId,
    int RatePerSecond,
    long RebuiltCount,
    long FailedCount,
    DateTimeOffset UpdatedAtUtc);

public interface IArticleDetailAedsArtifactMaintenanceService
{
    Task<ArticleDetailAedsArtifactMaintenanceResult> RecomputeArticleRightsAsync(CancellationToken cancellationToken = default);

    Task<ArticleDetailAedsArtifactMaintenanceResult> ClearLegacyPublicArtifactsAsync(CancellationToken cancellationToken = default);

    Task<ArticleDetailAedsArtifactMaintenanceResult> RebuildArticleDetailAedsV3Async(
        bool all,
        int? articleId = null,
        CancellationToken cancellationToken = default);

    Task<PublicArticleProjectionBackfillState> GetPublicProjectionBackfillStateAsync(
        CancellationToken cancellationToken = default)
        => Task.FromResult(new PublicArticleProjectionBackfillState(
            "unsupported",
            0,
            1,
            0,
            0,
            DateTimeOffset.MinValue));

    Task PausePublicProjectionBackfillAsync(CancellationToken cancellationToken = default)
        => Task.CompletedTask;

    Task<ArticleDetailAedsArtifactMaintenanceResult> ResumePublicProjectionBackfillAsync(
        CancellationToken cancellationToken = default)
        => RebuildArticleDetailAedsV3Async(all: true, articleId: null, cancellationToken);
}

public sealed class ArticleDetailAedsFileArtifactStore(
    IWebHostEnvironment env,
    ILogger<ArticleDetailAedsFileArtifactStore> logger,
    TimeProvider? timeProvider = null,
    IPublicArtifactStorage? publicArtifactStorage = null) : IArticleDetailAedsArtifactStore
{
    private const uint ArticleDetailV3PayloadMagic = 0x41524433; // ARD3
    private const int ArticleDetailV3PayloadVersion = 3;
    private const uint ArticleDetailV4PayloadMagic = 0x41524434; // ARD4
    private const int ArticleDetailV4PayloadVersion = 4;
    private const uint ArticleDetailV5PayloadMagic = 0x41524435; // ARD5
    private const int ArticleDetailV5PayloadVersion = 5;
    private const int ArticleDetailV3HeaderSize = sizeof(uint) + sizeof(int);
    private static readonly TimeSpan s_memoryTtl = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<int, CachedFrame> _memory = new();
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly IPublicArtifactStorage _publicArtifactStorage = publicArtifactStorage ?? new LocalPublicArtifactStorage(env);

    public async Task<ArticleDetailAedsArtifact> TryReadAsync(int articleId, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (articleId <= 0)
        {
            return default;
        }

        if (TryReadMemory(articleId, out byte[]? frame))
        {
            FsusObservability.RecordArticleDetailArtifactMemoryHit(FsusObservability.GetElapsed(startedAt));
            return new ArticleDetailAedsArtifact(frame);
        }

        PublicArtifactReadResult? stored = await _publicArtifactStorage.TryReadAsync(
            PublicArtifactKey.ArticleDetail(articleId),
            LocalPublicArtifactStorage.AedsMediaType,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (stored is null)
        {
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "miss", FsusObservability.GetElapsed(startedAt));
            return default;
        }

        byte[] bytes = stored.Content.ToArray();
        if (!LooksLikeAedsArticleDetailFrame(bytes))
        {
            logger.LogWarning("article-detail-aeds-artifact-invalid {ArticleId}", articleId);
            _memory.TryRemove(articleId, out _);
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "invalid", FsusObservability.GetElapsed(startedAt));
            return default;
        }

        _memory[articleId] = new CachedFrame(bytes, _timeProvider.GetUtcNow().Add(s_memoryTtl));
        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "hit_file", FsusObservability.GetElapsed(startedAt));
        return new ArticleDetailAedsArtifact(bytes);
    }

    public async Task WriteAsync(int articleId, ReadOnlyMemory<byte> frame, CancellationToken cancellationToken = default)
    {
        if (articleId <= 0 || frame.IsEmpty)
        {
            return;
        }

        byte[] bytes = frame.ToArray();
        if (!LooksLikeAedsArticleDetailFrame(bytes))
        {
            throw new InvalidDataException($"article_detail_aeds_artifact_invalid:{articleId}");
        }

        await _publicArtifactStorage.WriteAsync(
            PublicArtifactKey.ArticleDetail(articleId),
            LocalPublicArtifactStorage.AedsMediaType,
            bytes,
            cancellationToken).ConfigureAwait(false);
        _memory[articleId] = new CachedFrame(bytes, _timeProvider.GetUtcNow().Add(s_memoryTtl));
        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "write", TimeSpan.Zero);
    }

    public Task RemoveAsync(int articleId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _memory.TryRemove(articleId, out _);
        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "remove", TimeSpan.Zero);
        return _publicArtifactStorage.RemoveAsync(PublicArtifactKey.ArticleDetail(articleId), cancellationToken);
    }

    private bool TryReadMemory(int articleId, out byte[]? frame)
    {
        frame = null;
        if (!_memory.TryGetValue(articleId, out CachedFrame? cached))
        {
            return false;
        }

        if (cached.ExpiresAtUtc <= _timeProvider.GetUtcNow())
        {
            _memory.TryRemove(articleId, out _);
            return false;
        }

        frame = cached.Frame;
        return true;
    }

    internal static bool LooksLikeAedsArticleDetailFrame(ReadOnlySpan<byte> frame)
    {
        if (frame.Length < AedsFrameHeader.Size + ArticleDetailV3HeaderSize)
        {
            return false;
        }

        if (BinaryPrimitives.ReadUInt32LittleEndian(frame[..4]) != AedsEncoder.Magic
            || frame[4] != AedsFrameHeader.CurrentVersion
            || frame[5] != AedsFrameHeader.Size
            || BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]) != (ushort)AedsFrameType.ArticleDetail)
        {
            return false;
        }

        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(frame[10..14]);
        if (payloadLength < ArticleDetailV3HeaderSize
            || payloadLength != (uint)(frame.Length - AedsFrameHeader.Size))
        {
            return false;
        }

        ReadOnlySpan<byte> payload = frame[AedsFrameHeader.Size..];
        uint payloadMagic = BinaryPrimitives.ReadUInt32LittleEndian(payload[..sizeof(uint)]);
        int payloadVersion = BinaryPrimitives.ReadInt32LittleEndian(payload[sizeof(uint)..ArticleDetailV3HeaderSize]);
        return (payloadMagic == ArticleDetailV3PayloadMagic && payloadVersion == ArticleDetailV3PayloadVersion)
            || (payloadMagic == ArticleDetailV4PayloadMagic && payloadVersion == ArticleDetailV4PayloadVersion)
            || (payloadMagic == ArticleDetailV5PayloadMagic && payloadVersion == ArticleDetailV5PayloadVersion);
    }

    private sealed record CachedFrame(byte[] Frame, DateTimeOffset ExpiresAtUtc);
}

public sealed class ArticleDetailAedsArtifactMaintenanceService(
    ISqlSugarClient db,
    IWebHostEnvironment env,
    IServiceScopeFactory scopeFactory,
    IArticleDetailAedsArtifactProjector projector,
    IDbConcurrencyGate dbGate,
    TimeProvider timeProvider,
    ILogger<ArticleDetailAedsArtifactMaintenanceService> logger) : IArticleDetailAedsArtifactMaintenanceService
{
    private const int RightsRecomputeBatchSize = 128;
    private const string RecomputePolicyHashSentinel = "rights-v3:policy-hash:recompute";
    private const string RecomputeContentHashSentinel = "rights-v3:content-hash:recompute";
    private readonly string _artifactRoot = Path.Combine(env.ContentRootPath, "runtime-cache", "public", "articles");

    public async Task<ArticleDetailAedsArtifactMaintenanceResult> RecomputeArticleRightsAsync(CancellationToken cancellationToken = default)
    {
        int scanned = 0;
        int rebuilt = 0;
        int failed = 0;
        int lastArticleId = 0;

        while (true)
        {
            IReadOnlyList<RightsRecomputeCandidate> candidates =
                await LoadRightsRecomputeCandidatesAsync(lastArticleId, RightsRecomputeBatchSize, cancellationToken).ConfigureAwait(false);
            if (candidates.Count == 0)
            {
                break;
            }

            foreach (RightsRecomputeCandidate candidate in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                scanned++;
                lastArticleId = Math.Max(lastArticleId, candidate.ArticleId);
                try
                {
                    await RecomputeRightsSnapshotAsync(candidate, cancellationToken).ConfigureAwait(false);
                    rebuilt++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    failed++;
                    logger.LogWarning(ex, "article-rights-recompute-failed {ArticleId}", candidate.ArticleId);
                }
            }
        }

        return new ArticleDetailAedsArtifactMaintenanceResult(scanned, rebuilt, Removed: 0, Skipped: 0, failed);
    }

    public async Task<ArticleDetailAedsArtifactMaintenanceResult> ClearLegacyPublicArtifactsAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_artifactRoot))
        {
            return new ArticleDetailAedsArtifactMaintenanceResult(Scanned: 0, Rebuilt: 0, Removed: 0, Skipped: 0, Failed: 0);
        }

        int scanned = 0;
        int removed = 0;
        int skipped = 0;
        int failed = 0;
        foreach (string path in Directory.EnumerateFiles(_artifactRoot, "*.aeds", SearchOption.TopDirectoryOnly))
        {
            cancellationToken.ThrowIfCancellationRequested();
            scanned++;
            try
            {
                byte[] frame = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                if (ArticleDetailAedsFileArtifactStore.LooksLikeAedsArticleDetailFrame(frame))
                {
                    skipped++;
                    continue;
                }

                File.Delete(path);
                removed++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning(ex, "article-detail-aeds-clear-legacy-failed {Path}", path);
            }
        }

        return new ArticleDetailAedsArtifactMaintenanceResult(scanned, Rebuilt: 0, removed, skipped, failed);
    }

    public async Task<ArticleDetailAedsArtifactMaintenanceResult> RebuildArticleDetailAedsV3Async(
        bool all,
        int? articleId = null,
        CancellationToken cancellationToken = default)
    {
        if (!all)
        {
            if (articleId is not > 0)
            {
                return new ArticleDetailAedsArtifactMaintenanceResult(Scanned: 0, Rebuilt: 0, Removed: 0, Skipped: 1, Failed: 0);
            }

            try
            {
                await projector.GenerateAndStoreAsync(articleId.Value, cancellationToken).ConfigureAwait(false);
                return new ArticleDetailAedsArtifactMaintenanceResult(Scanned: 1, Rebuilt: 1, Removed: 0, Skipped: 0, Failed: 0);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "article-detail-aeds-rebuild-failed {ArticleId}", articleId.Value);
                return new ArticleDetailAedsArtifactMaintenanceResult(Scanned: 1, Rebuilt: 0, Removed: 0, Skipped: 0, Failed: 1);
            }
        }

        int scanned = 0;
        int rebuilt = 0;
        int failed = 0;
        PublicArticleProjectionBackfillState state = await GetPublicProjectionBackfillStateAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!string.Equals(state.State, "running", StringComparison.Ordinal))
        {
            await SetPublicProjectionBackfillStateAsync("running", cancellationToken).ConfigureAwait(false);
            state = state with
            {
                State = "running"
            };
        }

        int lastArticleId = state.LastArticleId;
        while (true)
        {
            state = await GetPublicProjectionBackfillStateAsync(cancellationToken).ConfigureAwait(false);
            if (string.Equals(state.State, "paused", StringComparison.Ordinal))
            {
                return new ArticleDetailAedsArtifactMaintenanceResult(scanned, rebuilt, Removed: 0, Skipped: 1, failed);
            }

            long batchStarted = Stopwatch.GetTimestamp();
            int batchSize = ResolveProjectionBackfillBatchSize();
            IReadOnlyList<int> articleIds = await LoadPublicArticleIdsPageAsync(lastArticleId, batchSize, cancellationToken)
                .ConfigureAwait(false);
            if (articleIds.Count == 0)
            {
                await CompletePublicProjectionBackfillAsync(cancellationToken).ConfigureAwait(false);
                break;
            }

            scanned += articleIds.Count;
            lastArticleId = articleIds[^1];
            int degreeOfParallelism = ResolveBackfillParallelism(articleIds.Count, state.RatePerSecond);
            (int batchRebuilt, int batchFailed) = await RebuildArticleBatchAsync(articleIds, degreeOfParallelism, cancellationToken)
                .ConfigureAwait(false);
            rebuilt += batchRebuilt;
            failed += batchFailed;
            await RecordPublicProjectionBackfillProgressAsync(lastArticleId, batchRebuilt, batchFailed, cancellationToken)
                .ConfigureAwait(false);

            TimeSpan targetBatchDuration = TimeSpan.FromSeconds((double)articleIds.Count / Math.Max(1, state.RatePerSecond));
            TimeSpan remaining = targetBatchDuration - Stopwatch.GetElapsedTime(batchStarted);
            if (remaining > TimeSpan.Zero)
            {
                await Task.Delay(remaining, cancellationToken).ConfigureAwait(false);
            }
        }

        return new ArticleDetailAedsArtifactMaintenanceResult(scanned, rebuilt, Removed: 0, Skipped: 0, failed);
    }

    private async Task<IReadOnlyList<int>> LoadPublicArticleIdsPageAsync(int afterArticleId, int limit, CancellationToken ct)
    {
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        var rows = await db.Queryable<Article>()
            .Where(article => article.Id > afterArticleId
                && !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .OrderBy(article => article.Id)
            .Take(limit)
            .Select(article => article.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        return rows;
    }

    public async Task<PublicArticleProjectionBackfillState> GetPublicProjectionBackfillStateAsync(
        CancellationToken cancellationToken = default)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT state, last_article_id, rate_per_second, rebuilt_count, failed_count, updated_at_utc
            FROM public_article_projection_backfill
            WHERE scope = 'global';
            """).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("public_article_projection_backfill_state_missing");
        }

        DateTime updatedAt = reader.GetDateTime(5);
        return new PublicArticleProjectionBackfillState(
            reader.GetString(0),
            reader.GetInt32(1),
            reader.GetInt32(2),
            reader.GetInt64(3),
            reader.GetInt64(4),
            new DateTimeOffset(DateTime.SpecifyKind(updatedAt, DateTimeKind.Utc)));
    }

    public Task PausePublicProjectionBackfillAsync(CancellationToken cancellationToken = default)
        => SetPublicProjectionBackfillStateAsync("paused", cancellationToken);

    public async Task<ArticleDetailAedsArtifactMaintenanceResult> ResumePublicProjectionBackfillAsync(
        CancellationToken cancellationToken = default)
    {
        await SetPublicProjectionBackfillStateAsync("running", cancellationToken).ConfigureAwait(false);
        return await RebuildArticleDetailAedsV3Async(all: true, articleId: null, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private int ResolveBackfillParallelism(int itemCount, int ratePerSecond)
    {
        int gateLimit = ResolveBackgroundGateLimit();
        return PublicArticleProjectionBackfillPolicy.ResolveParallelism(itemCount, ratePerSecond, gateLimit);
    }

    private int ResolveProjectionBackfillBatchSize()
        => PublicArticleProjectionBackfillPolicy.ResolveBatchSize(ResolveBackgroundGateLimit());

    private int ResolveBackgroundGateLimit()
        => dbGate is IClassifiedDbConcurrencyGate classified
            && classified.GetDiagnostics().Workloads.TryGetValue("background-projection-rebuild", out DbWorkloadGateSnapshot snapshot)
                ? snapshot.Limit
                : 1;

    private async Task<(int Rebuilt, int Failed)> RebuildArticleBatchAsync(
        IReadOnlyList<int> articleIds,
        int degreeOfParallelism,
        CancellationToken ct)
    {
        int rebuilt = 0;
        int failed = 0;
        await Parallel.ForEachAsync(
                articleIds,
                new ParallelOptions { CancellationToken = ct, MaxDegreeOfParallelism = degreeOfParallelism },
                async (id, itemCt) =>
                {
                    try
                    {
                        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                        var scopedProjector = scope.ServiceProvider.GetRequiredService<IArticleDetailAedsArtifactProjector>();
                        await scopedProjector.GenerateAndStoreAsync(id, itemCt).ConfigureAwait(false);
                        Interlocked.Increment(ref rebuilt);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        Interlocked.Increment(ref failed);
                        logger.LogWarning(ex, "article-detail-aeds-rebuild-failed {ArticleId}", id);
                    }
                })
            .ConfigureAwait(false);
        return (rebuilt, failed);
    }

    private async Task SetPublicProjectionBackfillStateAsync(string state, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE public_article_projection_backfill
            SET state = @State,
                updated_at_utc = (now() AT TIME ZONE 'utc')
            WHERE scope = 'global';
            """,
            new SugarParameter("@State", state)).ConfigureAwait(false);
    }

    private async Task RecordPublicProjectionBackfillProgressAsync(
        int lastArticleId,
        int rebuilt,
        int failed,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE public_article_projection_backfill
            SET last_article_id = GREATEST(last_article_id, @LastArticleId),
                rebuilt_count = rebuilt_count + @Rebuilt,
                failed_count = failed_count + @Failed,
                updated_at_utc = (now() AT TIME ZONE 'utc')
            WHERE scope = 'global';
            """,
            new SugarParameter("@LastArticleId", lastArticleId),
            new SugarParameter("@Rebuilt", rebuilt),
            new SugarParameter("@Failed", failed)).ConfigureAwait(false);
    }

    private async Task CompletePublicProjectionBackfillAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE public_article_projection_backfill
            SET state = 'completed',
                updated_at_utc = (now() AT TIME ZONE 'utc')
            WHERE scope = 'global';
            """).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<RightsRecomputeCandidate>> LoadRightsRecomputeCandidatesAsync(
        int afterArticleId,
        int limit,
        CancellationToken ct)
    {
        var rows = new List<RightsRecomputeCandidate>(limit);
        string sql = """
            WITH latest_revision AS (
                SELECT DISTINCT ON (revision.article_id)
                    revision.id,
                    revision.article_id,
                    revision.revision_no,
                    revision.title,
                    revision.summary,
                    revision.cover_image_url,
                    revision.categoryid,
                    revision.tag_ids,
                    revision.content_block_id,
                    revision.created_at
                FROM article_revision revision
                ORDER BY revision.article_id, revision.revision_no DESC, revision.created_at DESC, revision.id DESC
            )
            SELECT
                a.id AS "ArticleId",
                COALESCE(revision.title, a.title, '') AS "Title",
                COALESCE(revision.summary, a.summary) AS "Summary",
                COALESCE(revision.cover_image_url, a.coverimageurl) AS "CoverImageUrl",
                COALESCE(revision.categoryid, a.categoryid) AS "CategoryId",
                COALESCE(revision.tag_ids, '') AS "TagIds",
                revision.content_block_id AS "ContentBlockId",
                block.id AS "ResolvedContentBlockId",
                block.markdown_content AS "MarkdownContent",
                a.status AS "Status",
                a.published_at AS "PublishedAt",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                revision.id AS "ArticleRevisionId",
                revision.revision_no AS "RevisionNo",
                policy.id AS "PolicyId",
                COALESCE(snapshot.enabled, policy.enabled, true) AS "RightsEnabled",
                COALESCE(snapshot.license_type, policy.license_type, 'all-rights-reserved') AS "LicenseType",
                COALESCE(snapshot.copyright_holder, policy.copyright_holder) AS "CopyrightHolder",
                COALESCE(snapshot.copyright_year, policy.copyright_year) AS "CopyrightYear",
                COALESCE(snapshot.rights_statement, policy.rights_statement) AS "RightsStatement",
                COALESCE(snapshot.attribution_template, policy.attribution_template) AS "AttributionTemplate",
                COALESCE(snapshot.copy_policy, policy.copy_policy, 'append-attribution') AS "CopyPolicy",
                COALESCE(snapshot.max_excerpt_chars, policy.max_excerpt_chars, 300) AS "MaxExcerptChars",
                COALESCE(snapshot.allow_code_copy, policy.allow_code_copy, true) AS "AllowCodeCopy",
                COALESCE(snapshot.show_public_badge, policy.show_public_badge, true) AS "ShowPublicBadge",
                COALESCE(snapshot.proof_binding_enabled, policy.proof_binding_enabled, true) AS "ProofBindingEnabled",
                snapshot.canonical_url AS "CanonicalUrl",
                snapshot.id AS "SnapshotId",
                snapshot.policy_hash AS "PolicyHash",
                snapshot.content_canonical_hash AS "ContentCanonicalHash"
            FROM article a
            JOIN latest_revision revision ON revision.article_id = a.id
            LEFT JOIN article_revision_content_block block ON block.id = revision.content_block_id
            LEFT JOIN article_rights_policy policy ON policy.article_id = a.id
            LEFT JOIN article_rights_snapshot snapshot
                ON snapshot.article_id = a.id
               AND snapshot.article_revision_id = revision.id
            WHERE a.id > @AfterArticleId
              AND (
                    snapshot.id IS NULL
                 OR snapshot.policy_hash = @PolicyHashSentinel
                 OR snapshot.content_canonical_hash = @ContentHashSentinel
              )
            ORDER BY a.id
            LIMIT @Limit;
            """;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                sql,
                new SugarParameter("@AfterArticleId", afterArticleId),
                new SugarParameter("@Limit", limit),
                new SugarParameter("@PolicyHashSentinel", RecomputePolicyHashSentinel),
                new SugarParameter("@ContentHashSentinel", RecomputeContentHashSentinel))
            .ConfigureAwait(false);

        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            long revisionId = reader.GetInt64(reader.GetOrdinal("ArticleRevisionId"));
            long contentBlockId = ReadNullableInt64(reader, "ContentBlockId") ?? 0;
            if (revisionId <= 0
                || contentBlockId <= 0
                || ReadNullableInt64(reader, "ResolvedContentBlockId") != contentBlockId
                || reader.IsDBNull(reader.GetOrdinal("MarkdownContent")))
            {
                throw new InvalidOperationException($"article_revision_content_block_missing:{revisionId}:{contentBlockId}");
            }

            rows.Add(ReadRightsRecomputeCandidate(reader));
        }

        return rows;
    }

    private async Task RecomputeRightsSnapshotAsync(RightsRecomputeCandidate candidate, CancellationToken ct)
    {
        long policyId = candidate.PolicyId > 0
            ? candidate.PolicyId
            : await InsertDefaultRightsPolicyAsync(candidate.ArticleId, ct).ConfigureAwait(false);
        IReadOnlyList<int> tagIds = ParseTagIds(candidate.TagIds);
        string contentCanonicalHash = "sha256:" + ArticleCanonicalHashV1.ComputeHashHex(new ArticleCanonicalInput(
            ArticleId: candidate.ArticleId,
            ArticleRevisionId: candidate.ArticleRevisionId,
            RevisionNo: candidate.RevisionNo,
            PublicRouteKey: $"article:{candidate.ArticleId}",
            Title: candidate.Title,
            Summary: candidate.Summary,
            CoverImageUrl: candidate.CoverImageUrl,
            CategoryId: candidate.CategoryId,
            TagIds: tagIds,
            Status: candidate.Status,
            PublishedAt: candidate.PublishedAt,
            ScheduledPublishAt: candidate.ScheduledPublishAt,
            MarkdownContent: candidate.MarkdownContent));
        string policyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(new ArticleRightsCanonicalInput(
            ArticleId: candidate.ArticleId,
            ArticleRevisionId: candidate.ArticleRevisionId,
            RevisionNo: candidate.RevisionNo,
            LicenseType: candidate.LicenseType,
            CopyrightHolder: candidate.CopyrightHolder,
            CopyrightYear: candidate.CopyrightYear,
            RightsStatement: candidate.RightsStatement,
            AttributionTemplate: candidate.AttributionTemplate,
            CopyPolicy: candidate.CopyPolicy,
            MaxExcerptChars: candidate.MaxExcerptChars,
            AllowCodeCopy: candidate.AllowCodeCopy,
            ShowPublicBadge: candidate.ShowPublicBadge,
            CanonicalUrl: candidate.CanonicalUrl,
            ContentCanonicalHash: contentCanonicalHash));

        await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_rights_snapshot (
                    article_id,
                    article_revision_id,
                    revision_no,
                    article_rights_policy_id,
                    enabled,
                    license_type,
                    copyright_holder,
                    copyright_year,
                    rights_statement,
                    attribution_template,
                    copy_policy,
                    max_excerpt_chars,
                    allow_code_copy,
                    show_public_badge,
                    proof_binding_enabled,
                    canonical_url,
                    policy_hash,
                    content_canonical_hash,
                    created_at
                )
                VALUES (
                    @ArticleId,
                    @ArticleRevisionId,
                    @RevisionNo,
                    @PolicyId,
                    @Enabled,
                    @LicenseType,
                    @CopyrightHolder,
                    @CopyrightYear,
                    @RightsStatement,
                    @AttributionTemplate,
                    @CopyPolicy,
                    @MaxExcerptChars,
                    @AllowCodeCopy,
                    @ShowPublicBadge,
                    @ProofBindingEnabled,
                    @CanonicalUrl,
                    @PolicyHash,
                    @ContentCanonicalHash,
                    @CreatedAt
                )
                ON CONFLICT (article_id, article_revision_id)
                DO UPDATE SET
                    policy_hash = EXCLUDED.policy_hash,
                    content_canonical_hash = EXCLUDED.content_canonical_hash;
                """,
                new SugarParameter("@ArticleId", candidate.ArticleId),
                new SugarParameter("@ArticleRevisionId", candidate.ArticleRevisionId),
                new SugarParameter("@RevisionNo", candidate.RevisionNo),
                new SugarParameter("@PolicyId", policyId),
                new SugarParameter("@Enabled", candidate.Enabled),
                new SugarParameter("@LicenseType", candidate.LicenseType),
                NullableStringParameter("@CopyrightHolder", candidate.CopyrightHolder),
                NullableInt32Parameter("@CopyrightYear", candidate.CopyrightYear),
                NullableStringParameter("@RightsStatement", candidate.RightsStatement),
                NullableStringParameter("@AttributionTemplate", candidate.AttributionTemplate),
                new SugarParameter("@CopyPolicy", candidate.CopyPolicy),
                new SugarParameter("@MaxExcerptChars", candidate.MaxExcerptChars),
                new SugarParameter("@AllowCodeCopy", candidate.AllowCodeCopy),
                new SugarParameter("@ShowPublicBadge", candidate.ShowPublicBadge),
                new SugarParameter("@ProofBindingEnabled", candidate.ProofBindingEnabled),
                NullableStringParameter("@CanonicalUrl", candidate.CanonicalUrl),
                new SugarParameter("@PolicyHash", policyHash),
                new SugarParameter("@ContentCanonicalHash", contentCanonicalHash),
                new SugarParameter("@CreatedAt", timeProvider.GetUtcNow().UtcDateTime))
            .ConfigureAwait(false);
    }

    private async Task<long> InsertDefaultRightsPolicyAsync(int articleId, CancellationToken ct)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                INSERT INTO article_rights_policy (
                    article_id,
                    enabled,
                    license_type,
                    copy_policy,
                    max_excerpt_chars,
                    allow_code_copy,
                    show_public_badge,
                    proof_binding_enabled,
                    created_at,
                    updated_at
                )
                VALUES (
                    @ArticleId,
                    true,
                    'all-rights-reserved',
                    'append-attribution',
                    300,
                    true,
                    true,
                    true,
                    @Now,
                    @Now
                )
                ON CONFLICT (article_id)
                DO UPDATE SET updated_at = article_rights_policy.updated_at
                RETURNING id;
                """,
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@Now", timeProvider.GetUtcNow().UtcDateTime))
            .ConfigureAwait(false);
        if (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            return reader.GetInt64(0);
        }

        throw new InvalidOperationException($"Article rights policy was not available for article {articleId}.");
    }

    private static RightsRecomputeCandidate ReadRightsRecomputeCandidate(DbDataReader reader)
        => new(
            ArticleId: reader.GetInt32(reader.GetOrdinal("ArticleId")),
            Title: ReadStringOrDefault(reader, "Title", string.Empty),
            Summary: ReadNullableString(reader, "Summary"),
            CoverImageUrl: ReadNullableString(reader, "CoverImageUrl"),
            CategoryId: reader.GetInt32(reader.GetOrdinal("CategoryId")),
            TagIds: ReadStringOrDefault(reader, "TagIds", string.Empty),
            MarkdownContent: reader.GetString(reader.GetOrdinal("MarkdownContent")),
            Status: reader.GetInt32(reader.GetOrdinal("Status")),
            PublishedAt: ReadNullableDateTime(reader, "PublishedAt"),
            ScheduledPublishAt: ReadNullableDateTime(reader, "ScheduledPublishAt"),
            ArticleRevisionId: reader.GetInt64(reader.GetOrdinal("ArticleRevisionId")),
            RevisionNo: reader.GetInt32(reader.GetOrdinal("RevisionNo")),
            PolicyId: ReadNullableInt64(reader, "PolicyId") ?? 0,
            Enabled: reader.GetBoolean(reader.GetOrdinal("RightsEnabled")),
            LicenseType: ReadStringOrDefault(reader, "LicenseType", "all-rights-reserved"),
            CopyrightHolder: ReadNullableString(reader, "CopyrightHolder"),
            CopyrightYear: ReadNullableInt32(reader, "CopyrightYear"),
            RightsStatement: ReadNullableString(reader, "RightsStatement"),
            AttributionTemplate: ReadNullableString(reader, "AttributionTemplate"),
            CopyPolicy: ReadStringOrDefault(reader, "CopyPolicy", "append-attribution"),
            MaxExcerptChars: reader.GetInt32(reader.GetOrdinal("MaxExcerptChars")),
            AllowCodeCopy: reader.GetBoolean(reader.GetOrdinal("AllowCodeCopy")),
            ShowPublicBadge: reader.GetBoolean(reader.GetOrdinal("ShowPublicBadge")),
            ProofBindingEnabled: reader.GetBoolean(reader.GetOrdinal("ProofBindingEnabled")),
            CanonicalUrl: ReadNullableString(reader, "CanonicalUrl"),
            SnapshotId: ReadNullableInt64(reader, "SnapshotId") ?? 0,
            PolicyHash: ReadNullableString(reader, "PolicyHash"),
            ContentCanonicalHash: ReadNullableString(reader, "ContentCanonicalHash"));

    private static IReadOnlyList<int> ParseTagIds(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return [];
        }

        return
        [
            .. value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(static item => int.TryParse(item, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id) ? id : 0)
                .Where(static id => id > 0)
                .Distinct()
                .OrderBy(static id => id)
        ];
    }

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, (object?)value ?? DBNull.Value);

    private static SugarParameter NullableInt32Parameter(string name, int? value)
        => new(name, (object?)value ?? DBNull.Value);

    private static string ReadStringOrDefault(DbDataReader reader, string fieldName, string defaultValue)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? defaultValue : reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static long? ReadNullableInt64(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);
    }

    private static DateTime? ReadNullableDateTime(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetDateTime(ordinal);
    }

    private sealed record RightsRecomputeCandidate(
        int ArticleId,
        string Title,
        string? Summary,
        string? CoverImageUrl,
        int CategoryId,
        string TagIds,
        string MarkdownContent,
        int Status,
        DateTime? PublishedAt,
        DateTime? ScheduledPublishAt,
        long ArticleRevisionId,
        int RevisionNo,
        long PolicyId,
        bool Enabled,
        string LicenseType,
        string? CopyrightHolder,
        int? CopyrightYear,
        string? RightsStatement,
        string? AttributionTemplate,
        string CopyPolicy,
        int MaxExcerptChars,
        bool AllowCodeCopy,
        bool ShowPublicBadge,
        bool ProofBindingEnabled,
        string? CanonicalUrl,
        long SnapshotId,
        string? PolicyHash,
        string? ContentCanonicalHash);
}

public sealed class ArticleDetailAedsArtifactBackfillScheduler(
    ILogger<ArticleDetailAedsArtifactBackfillScheduler> logger) : IArticleDetailAedsArtifactBackfillScheduler
{
    private const int Capacity = 1024;
    private readonly Channel<int> _channel = Channel.CreateBounded<int>(new BoundedChannelOptions(Capacity)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.DropWrite
    });
    private readonly ConcurrentDictionary<int, byte> _scheduled = new();

    public ChannelReader<int> Reader => _channel.Reader;

    internal int PendingCount => _scheduled.Count;

    public bool TrySchedule(int articleId)
    {
        if (articleId <= 0 || !_scheduled.TryAdd(articleId, 0))
        {
            return false;
        }

        if (_channel.Writer.TryWrite(articleId))
        {
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "backfill_queued", TimeSpan.Zero);
            return true;
        }

        _scheduled.TryRemove(articleId, out _);
        logger.LogWarning("article-detail-aeds-backfill-queue-full {ArticleId}", articleId);
        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "backfill_dropped", TimeSpan.Zero);
        return false;
    }

    internal void MarkCompleted(int articleId)
        => _scheduled.TryRemove(articleId, out _);
}

public sealed class ArticleDetailAedsArtifactBackfillWorker(
    ArticleDetailAedsArtifactBackfillScheduler scheduler,
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleDetailAedsArtifactBackfillWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (int articleId in scheduler.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                var projector = scope.ServiceProvider.GetRequiredService<IArticleDetailAedsArtifactProjector>();
                await projector.GenerateAndStoreAsync(articleId, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "article-detail-aeds-backfill-failed {ArticleId}", articleId);
                FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "backfill_failed", TimeSpan.Zero);
            }
            finally
            {
                scheduler.MarkCompleted(articleId);
            }
        }
    }
}

public sealed class ArticleDetailAedsArtifactProjector(
    ISqlSugarClient db,
    IArticleDetailAedsArtifactStore store,
    IPublicArticleProjectionStore publicProjection,
    IDbConcurrencyGate dbGate,
    ArticleBodyRepairQueue articleBodyRepairQueue,
    TimeProvider timeProvider,
    ILogger<ArticleDetailAedsArtifactProjector> logger)
    : IArticleDetailAedsArtifactProjector, IVersionedArticleDetailAedsArtifactProjector
{
    public Task GenerateAndStoreAsync(int articleId, CancellationToken cancellationToken = default)
        => GenerateAndStoreAsync(articleId, default, cancellationToken);

    public Task GenerateAndStoreAsync(
        int articleId,
        ArticleMutationVersionReference version,
        CancellationToken cancellationToken = default)
        => dbGate.ExecuteClassifiedAsync(
            DbWorkloadClass.BackgroundProjection,
            "public-article-projection-build",
            async ct =>
            {
                ArticleDetailReadModel? article = await LoadArticleDetailFromDbAsync(articleId, version, ct).ConfigureAwait(false);
                if (article is null)
                {
                    if (ArticleMutationProjectionVersionPolicy.PreserveCurrentWhenCoordinateDoesNotResolve(
                        version.ReleaseId,
                        coordinateResolved: false))
                    {
                        logger.LogInformation(
                            "article-detail-aeds-version-skipped {ArticleId} {ExpectedReleaseId}",
                            articleId,
                            version.ReleaseId);
                        return true;
                    }

                    await ArticleDetailProjectionCommitSequence.MarkUnavailableAsync(
                        () => publicProjection.MarkUnavailableAsync(articleId, "not-public", ct),
                        () => store.RemoveAsync(articleId, ct)).ConfigureAwait(false);
                    return true;
                }

                if (string.IsNullOrWhiteSpace(article.Content))
                {
                    articleBodyRepairQueue.TrySchedule(articleId, "article-detail-aeds");
                    logger.LogWarning("article_detail_aeds_body_missing {ArticleId}", articleId);
                    FsusObservability.RecordOperation("article_body", "article_detail_aeds", "missing", TimeSpan.Zero);
                    await ArticleDetailProjectionCommitSequence.MarkUnavailableAsync(
                        () => publicProjection.MarkUnavailableAsync(articleId, "article-body-missing", ct),
                        () => store.RemoveAsync(articleId, ct)).ConfigureAwait(false);
                    return true;
                }

                if (!HasCompleteArticleRights(article.Rights))
                {
                    logger.LogWarning("article_detail_aeds_rights_missing {ArticleId}", articleId);
                    FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "rights_missing", TimeSpan.Zero);
                    await ArticleDetailProjectionCommitSequence.MarkUnavailableAsync(
                        () => publicProjection.MarkUnavailableAsync(articleId, "rights-missing", ct),
                        () => store.RemoveAsync(articleId, ct)).ConfigureAwait(false);
                    throw new InvalidOperationException($"article_detail_aeds_rights_missing:{articleId}");
                }

                using var frameWriter = new AedsFrameBufferWriter();
                PodBinaryCodec.WriteArticleDetail(
                    ArticleProjection.ToCoreDetailModel(article),
                    frameWriter.PayloadWriter);
                frameWriter.Seal(AedsFrameType.ArticleDetail);
                byte[] frame = frameWriter.WrittenFrame.ToArray();
                string contentHash = PublicArticleProjectionStore.CreateContentHash(frame);
                string etag = PublicArticleProjectionStore.CreateETag(frame);
                await ArticleDetailProjectionCommitSequence.PublishAsync(
                    () => publicProjection.UpsertAsync(
                        new PublicArticleProjectionWrite(articleId, frame, etag, contentHash, timeProvider.GetUtcNow()),
                        ct),
                    () => publicProjection.VerifyShadowParityAsync(articleId, frame, ct),
                    () => store.WriteAsync(articleId, frame, ct)).ConfigureAwait(false);
                return true;
            },
            _ => Task.FromException<bool>(new TimeoutException($"db-gate-timeout:public-article-projection-build:{articleId}")),
            cancellationToken);

    public async Task RemoveAsync(int articleId, CancellationToken cancellationToken = default)
    {
        await ArticleDetailProjectionCommitSequence.MarkUnavailableAsync(
            () => publicProjection.MarkUnavailableAsync(articleId, "removed", cancellationToken),
            () => store.RemoveAsync(articleId, cancellationToken)).ConfigureAwait(false);
    }

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(
        int id,
        ArticleMutationVersionReference version,
        CancellationToken ct)
    {
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        string sql = $$"""
            SELECT
                a.id AS "Id",
                revision.title AS "Title",
                revision.summary AS "Summary",
                revision.cover_image_url AS "CoverImageUrl",
                revision.categoryid AS "CategoryId",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                publication.published_at AS "PublishedAt",
                a.public_updated_at AS "UpdatedAt",
                c.name AS "CategoryName",
                COALESCE(body.markdown_content, '') AS "Content",
                rights.id AS "RightsSnapshotId",
                rights.article_revision_id AS "RightsArticleRevisionId",
                rights.revision_no AS "RightsRevisionNo",
                rights.enabled AS "RightsEnabled",
                rights.license_type AS "RightsLicenseType",
                rights.copyright_holder AS "RightsCopyrightHolder",
                rights.copyright_year AS "RightsCopyrightYear",
                rights.rights_statement AS "RightsStatement",
                rights.attribution_template AS "RightsAttributionTemplate",
                rights.copy_policy AS "RightsCopyPolicy",
                rights.max_excerpt_chars AS "RightsMaxExcerptChars",
                rights.allow_code_copy AS "RightsAllowCodeCopy",
                rights.show_public_badge AS "RightsShowPublicBadge",
                rights.proof_binding_enabled AS "RightsProofBindingEnabled",
                rights.canonical_url AS "RightsCanonicalUrl",
                rights.policy_hash AS "RightsPolicyHash",
                rights.content_canonical_hash AS "RightsContentCanonicalHash",
                CASE
                    WHEN rights_proof.id IS NULL THEN NULL
                    ELSE concat('urn:fsus:rights-proof:', rights_proof.id::text)
                END AS "RightsProofUrl",
                rights_proof.proof_status AS "RightsProofStatus",
                COALESCE(
                    array_agg(t.id ORDER BY t.id)
                        FILTER (WHERE t.id IS NOT NULL),
                    ARRAY[]::integer[]
                ) AS "TagIds",
                COALESCE(
                    array_agg(t.name ORDER BY t.id)
                        FILTER (WHERE t.id IS NOT NULL),
                    ARRAY[]::text[]
                ) AS "TagNames"
            FROM article a
            JOIN article_publication publication ON publication.id = a.current_publication_id
            JOIN article_revision revision ON revision.id = publication.article_revision_id
            LEFT JOIN article_body body ON body.article_id = a.id
            LEFT JOIN category c ON revision.categoryid = c.id
            LEFT JOIN LATERAL (
                SELECT snapshot.*
                FROM article_rights_snapshot snapshot
                WHERE snapshot.id = publication.rights_snapshot_id
                  AND (@RightsSnapshotId IS NULL OR snapshot.id = @RightsSnapshotId)
                LIMIT 1
            ) rights ON TRUE
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = rights.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE
            LEFT JOIN LATERAL unnest(
                COALESCE(
                    string_to_array(NULLIF(revision.tag_ids, ''), ',')::integer[],
                    ARRAY[]::integer[]
                )
            ) AS revision_tag(tag_id) ON TRUE
            LEFT JOIN tag t ON t.id = revision_tag.tag_id
            WHERE a.id = @Id
              AND (@ReleaseId IS NULL OR publication.id = @ReleaseId)
              AND (@RevisionId IS NULL OR revision.id = @RevisionId)
              AND (@RevisionNo IS NULL OR revision.revision_no = @RevisionNo)
              AND a.isdeleted = false
              AND a.status = @PublishedStatus
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            GROUP BY
                a.id,
                revision.title,
                revision.summary,
                revision.cover_image_url,
                revision.categoryid,
                body.markdown_content,
                a.views,
                a.createtime,
                a.isdeleted,
                a.status,
                a.scheduled_publish_at,
                publication.published_at,
                a.public_updated_at,
                c.name,
                rights.id,
                rights.article_revision_id,
                rights.revision_no,
                rights.enabled,
                rights.license_type,
                rights.copyright_holder,
                rights.copyright_year,
                rights.rights_statement,
                rights.attribution_template,
                rights.copy_policy,
                rights.max_excerpt_chars,
                rights.allow_code_copy,
                rights.show_public_badge,
                rights.proof_binding_enabled,
                rights.canonical_url,
                rights.policy_hash,
                rights.content_canonical_hash,
                rights_proof.id,
                rights_proof.proof_status;
            """;
        ArticleDetailReadModel? article = null;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            sql,
            new SugarParameter("@Id", id),
            new SugarParameter(
                "@ReleaseId",
                version.ReleaseId.HasValue ? version.ReleaseId.Value : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter(
                "@RevisionId",
                version.RevisionId.HasValue ? version.RevisionId.Value : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter(
                "@RevisionNo",
                version.RevisionNo.HasValue ? version.RevisionNo.Value : DBNull.Value,
                System.Data.DbType.Int32),
            new SugarParameter(
                "@RightsSnapshotId",
                version.RightsSnapshotId.HasValue ? version.RightsSnapshotId.Value : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter("@Now", utcNow),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published)))
        {
            if (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                int fId = reader.GetOrdinal("Id");
                int fTitle = reader.GetOrdinal("Title");
                int fSum = reader.GetOrdinal("Summary");
                int fCover = reader.GetOrdinal("CoverImageUrl");
                int fCatId = reader.GetOrdinal("CategoryId");
                int fViews = reader.GetOrdinal("Views");
                int fTime = reader.GetOrdinal("CreateTime");
                int fIsDel = reader.GetOrdinal("IsDeleted");
                int fStatus = reader.GetOrdinal("Status");
                int fScheduled = reader.GetOrdinal("ScheduledPublishAt");
                int fPublished = reader.GetOrdinal("PublishedAt");
                int fUpdated = reader.GetOrdinal("UpdatedAt");
                int fCatName = reader.GetOrdinal("CategoryName");
                int fContent = reader.GetOrdinal("Content");
                int fTagIds = reader.GetOrdinal("TagIds");
                int fTagNames = reader.GetOrdinal("TagNames");
                string content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent);
                string summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum);
                ReadingEstimate reading = ReadingEstimator.Estimate(content);

                article = new ArticleDetailReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = summary,
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    Status = (ArticleStatus)reader.GetInt32(fStatus),
                    ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : reader.GetDateTime(fScheduled),
                    PublishedAt = reader.IsDBNull(fPublished) ? null : reader.GetDateTime(fPublished),
                    UpdatedAt = reader.IsDBNull(fUpdated) ? null : reader.GetDateTime(fUpdated),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName),
                    Content = content,
                    WordCount = reading.EffectiveChars,
                    EstimatedReadingMinutes = reading.Minutes,
                    ShowReadingNotice = reading.ShowLongReadNotice,
                    Tags = ReadArticleDetailTags(reader, fTagIds, fTagNames),
                    Rights = ReadArticleRights(reader)
                };
            }
        }

        return article;
    }

    private static IReadOnlyList<TagReadModel> ReadArticleDetailTags(DbDataReader reader, int tagIdsOrdinal, int tagNamesOrdinal)
    {
        if (reader.IsDBNull(tagIdsOrdinal) || reader.IsDBNull(tagNamesOrdinal))
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        int[] tagIds = reader.GetFieldValue<int[]>(tagIdsOrdinal);
        string[] tagNames = reader.GetFieldValue<string[]>(tagNamesOrdinal);
        int count = Math.Min(tagIds.Length, tagNames.Length);
        if (count == 0)
        {
            return ArticleReadModelCollections.EmptyTags;
        }

        var tags = new List<TagReadModel>(count);
        for (int i = 0; i < count; i++)
        {
            tags.Add(new TagReadModel { Id = tagIds[i], Name = tagNames[i] });
        }

        return tags;
    }

    private static ArticleRightsReadModel ReadArticleRights(DbDataReader reader)
    {
        int snapshotId = reader.GetOrdinal("RightsSnapshotId");
        if (reader.IsDBNull(snapshotId))
        {
            return new ArticleRightsReadModel();
        }

        return new ArticleRightsReadModel
        {
            SnapshotId = reader.GetInt64(snapshotId),
            ArticleRevisionId = reader.GetInt64(reader.GetOrdinal("RightsArticleRevisionId")),
            RevisionNo = reader.GetInt32(reader.GetOrdinal("RightsRevisionNo")),
            Enabled = reader.GetBoolean(reader.GetOrdinal("RightsEnabled")),
            LicenseType = ReadStringOrDefault(reader, "RightsLicenseType", "all-rights-reserved"),
            CopyrightHolder = ReadNullableString(reader, "RightsCopyrightHolder"),
            CopyrightYear = ReadNullableInt32(reader, "RightsCopyrightYear"),
            RightsStatement = ReadNullableString(reader, "RightsStatement"),
            AttributionTemplate = ReadNullableString(reader, "RightsAttributionTemplate"),
            CopyPolicy = ReadStringOrDefault(reader, "RightsCopyPolicy", "append-attribution"),
            MaxExcerptChars = reader.GetInt32(reader.GetOrdinal("RightsMaxExcerptChars")),
            AllowCodeCopy = reader.GetBoolean(reader.GetOrdinal("RightsAllowCodeCopy")),
            ShowPublicBadge = reader.GetBoolean(reader.GetOrdinal("RightsShowPublicBadge")),
            ProofBindingEnabled = reader.GetBoolean(reader.GetOrdinal("RightsProofBindingEnabled")),
            CanonicalUrl = ReadNullableString(reader, "RightsCanonicalUrl"),
            PolicyHash = ReadStringOrDefault(reader, "RightsPolicyHash", string.Empty),
            ContentCanonicalHash = ReadStringOrDefault(reader, "RightsContentCanonicalHash", string.Empty),
            ProofUrl = ReadNullableString(reader, "RightsProofUrl"),
            ProofStatus = ReadNullableString(reader, "RightsProofStatus")
        };
    }

    private static bool HasCompleteArticleRights(ArticleRightsReadModel? rights)
        => rights is not null
            && rights.SnapshotId > 0
            && rights.ArticleRevisionId > 0
            && rights.RevisionNo > 0
            && !string.IsNullOrWhiteSpace(rights.LicenseType)
            && !string.IsNullOrWhiteSpace(rights.CopyPolicy)
            && !string.IsNullOrWhiteSpace(rights.PolicyHash)
            && !string.IsNullOrWhiteSpace(rights.ContentCanonicalHash);

    private static string ReadStringOrDefault(DbDataReader reader, string fieldName, string defaultValue)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? defaultValue : reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private async Task<string> LoadArticleContentAsync(int articleId, CancellationToken ct)
    {
        string content = await db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync() ?? string.Empty;

        return content;
    }

    private async Task<Dictionary<int, List<TagReadModel>>> LoadArticleTagMapAsync(IReadOnlyCollection<int> articleIds, CancellationToken ct)
    {
        if (articleIds.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var ids = articleIds
            .Where(id => id > 0)
            .Distinct()
            .ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var tagRows = await db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
            .Where(at => ids.Contains(at.ArticleId))
            .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach (var row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out var tags))
            {
                tags = [];
                tagMap[row.ArticleId] = tags;
            }

            tags.Add(new TagReadModel { Id = row.Id, Name = row.Name ?? string.Empty });
        }

        return tagMap;
    }

}
