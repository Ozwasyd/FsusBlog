using System.Collections.Concurrent;
using System.Diagnostics;
using System.Buffers.Binary;
using System.Data.Common;
using System.Globalization;
using System.Threading.Channels;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
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

public interface IArticleDetailAedsArtifactMaintenanceService
{
    Task<ArticleDetailAedsArtifactMaintenanceResult> RecomputeArticleRightsAsync(CancellationToken cancellationToken = default);

    Task<ArticleDetailAedsArtifactMaintenanceResult> ClearLegacyPublicArtifactsAsync(CancellationToken cancellationToken = default);

    Task<ArticleDetailAedsArtifactMaintenanceResult> RebuildArticleDetailAedsV3Async(
        bool all,
        int? articleId = null,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleDetailAedsFileArtifactStore(
    IWebHostEnvironment env,
    ILogger<ArticleDetailAedsFileArtifactStore> logger) : IArticleDetailAedsArtifactStore
{
    private const uint ArticleDetailV3PayloadMagic = 0x41524433; // ARD3
    private const int ArticleDetailV3PayloadVersion = 3;
    private const int ArticleDetailV3HeaderSize = sizeof(uint) + sizeof(int);
    private static readonly TimeSpan MemoryTtl = TimeSpan.FromSeconds(30);
    private readonly string _root = Path.Combine(env.ContentRootPath, "runtime-cache", "public", "articles");
    private readonly ConcurrentDictionary<int, CachedFrame> _memory = new();

    public async Task<ArticleDetailAedsArtifact> TryReadAsync(int articleId, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (articleId <= 0)
        {
            return default;
        }

        string path = GetPath(articleId);
        if (TryReadMemory(articleId, out byte[]? frame))
        {
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "hit_memory", FsusObservability.GetElapsed(startedAt));
            return new ArticleDetailAedsArtifact(frame);
        }

        if (!File.Exists(path))
        {
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "miss", FsusObservability.GetElapsed(startedAt));
            return default;
        }

        byte[] bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
        if (!LooksLikeAedsArticleDetailFrame(bytes))
        {
            logger.LogWarning("article-detail-aeds-artifact-invalid {ArticleId} {Path}", articleId, path);
            _memory.TryRemove(articleId, out _);
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "invalid", FsusObservability.GetElapsed(startedAt));
            return default;
        }

        _memory[articleId] = new CachedFrame(bytes, DateTimeOffset.UtcNow.Add(MemoryTtl));
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

        Directory.CreateDirectory(_root);
        string path = GetPath(articleId);
        string tempPath = string.Concat(path, ".", Guid.NewGuid().ToString("N"), ".tmp");
        await File.WriteAllBytesAsync(tempPath, bytes, cancellationToken).ConfigureAwait(false);
        File.Move(tempPath, path, overwrite: true);
        _memory[articleId] = new CachedFrame(bytes, DateTimeOffset.UtcNow.Add(MemoryTtl));
        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "write", TimeSpan.Zero);
    }

    public Task RemoveAsync(int articleId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _memory.TryRemove(articleId, out _);
        string path = GetPath(articleId);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "remove", TimeSpan.Zero);
        return Task.CompletedTask;
    }

    private bool TryReadMemory(int articleId, out byte[]? frame)
    {
        frame = null;
        if (!_memory.TryGetValue(articleId, out CachedFrame? cached))
        {
            return false;
        }

        if (cached.ExpiresAtUtc <= DateTimeOffset.UtcNow)
        {
            _memory.TryRemove(articleId, out _);
            return false;
        }

        frame = cached.Frame;
        return true;
    }

    private string GetPath(int articleId)
        => Path.Combine(_root, string.Concat(Math.Max(0, articleId).ToString(), ".aeds"));

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
        return BinaryPrimitives.ReadUInt32LittleEndian(payload[..sizeof(uint)]) == ArticleDetailV3PayloadMagic
            && BinaryPrimitives.ReadInt32LittleEndian(payload[sizeof(uint)..ArticleDetailV3HeaderSize]) == ArticleDetailV3PayloadVersion;
    }

    private sealed record CachedFrame(byte[] Frame, DateTimeOffset ExpiresAtUtc);
}

public sealed class ArticleDetailAedsArtifactMaintenanceService(
    ISqlSugarClient db,
    IWebHostEnvironment env,
    IServiceScopeFactory scopeFactory,
    IArticleDetailAedsArtifactProjector projector,
    ILogger<ArticleDetailAedsArtifactMaintenanceService> logger) : IArticleDetailAedsArtifactMaintenanceService
{
    private const int BatchSize = 128;
    private const int MaxRebuildConcurrency = 4;
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
                await LoadRightsRecomputeCandidatesAsync(lastArticleId, BatchSize, cancellationToken).ConfigureAwait(false);
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
                logger.LogWarning(ex, "article-detail-aeds-v3-rebuild-failed {ArticleId}", articleId.Value);
                return new ArticleDetailAedsArtifactMaintenanceResult(Scanned: 1, Rebuilt: 0, Removed: 0, Skipped: 0, Failed: 1);
            }
        }

        int scanned = 0;
        int rebuilt = 0;
        int failed = 0;
        int lastArticleId = 0;
        while (true)
        {
            IReadOnlyList<int> articleIds = await LoadPublicArticleIdsPageAsync(lastArticleId, BatchSize, cancellationToken)
                .ConfigureAwait(false);
            if (articleIds.Count == 0)
            {
                break;
            }

            scanned += articleIds.Count;
            lastArticleId = articleIds[^1];
            (int batchRebuilt, int batchFailed) = await RebuildArticleBatchAsync(articleIds, cancellationToken)
                .ConfigureAwait(false);
            rebuilt += batchRebuilt;
            failed += batchFailed;
        }

        return new ArticleDetailAedsArtifactMaintenanceResult(scanned, rebuilt, Removed: 0, Skipped: 0, failed);
    }

    private async Task<IReadOnlyList<int>> LoadPublicArticleIdsPageAsync(int afterArticleId, int limit, CancellationToken ct)
    {
        DateTime utcNow = DateTime.UtcNow;
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

    private async Task<(int Rebuilt, int Failed)> RebuildArticleBatchAsync(IReadOnlyList<int> articleIds, CancellationToken ct)
    {
        int rebuilt = 0;
        int failed = 0;
        int degreeOfParallelism = Math.Clamp(Environment.ProcessorCount / 2, 1, MaxRebuildConcurrency);
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
                        logger.LogWarning(ex, "article-detail-aeds-v3-rebuild-failed {ArticleId}", id);
                    }
                })
            .ConfigureAwait(false);
        return (rebuilt, failed);
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
                    revision.markdown_content,
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
                COALESCE(revision.markdown_content, body.markdown_content, '') AS "MarkdownContent",
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
            LEFT JOIN article_body body ON body.article_id = a.id
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
                new SugarParameter("@CreatedAt", DateTime.UtcNow))
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
                new SugarParameter("@Now", DateTime.UtcNow))
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
            MarkdownContent: ReadStringOrDefault(reader, "MarkdownContent", string.Empty),
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
    IAedsEncoder aeds,
    IArticleDetailAedsArtifactStore store,
    ILogger<ArticleDetailAedsArtifactProjector> logger) : IArticleDetailAedsArtifactProjector
{
    private bool? legacyArticleContentColumnExists;

    public async Task GenerateAndStoreAsync(int articleId, CancellationToken cancellationToken = default)
    {
        ArticleDetailReadModel? article = await LoadArticleDetailFromDbAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (article is null)
        {
            await store.RemoveAsync(articleId, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!HasCompleteArticleRights(article.Rights))
        {
            logger.LogWarning("article_detail_aeds_rights_missing {ArticleId}", articleId);
            FsusObservability.RecordOperation("public_read_artifact", "article_detail_aeds", "rights_missing", TimeSpan.Zero);
            await store.RemoveAsync(articleId, cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException($"article_detail_aeds_rights_missing:{articleId}");
        }

        byte[] payload = PodBinaryCodec.EncodeArticleDetail(ArticleProjection.ToCoreDetailModel(article));
        byte[] frame = aeds.Encode(AedsFrameType.ArticleDetail, payload);
        await store.WriteAsync(articleId, frame, cancellationToken).ConfigureAwait(false);
    }

    public Task RemoveAsync(int articleId, CancellationToken cancellationToken = default)
        => store.RemoveAsync(articleId, cancellationToken);

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(int id, CancellationToken ct)
    {
        DateTime utcNow = DateTime.UtcNow;
        bool hasLegacyContentColumn = await LegacyArticleContentColumnExistsAsync().ConfigureAwait(false);
        string contentExpression = hasLegacyContentColumn
            ? "COALESCE(NULLIF(ab.markdown_content, ''), NULLIF(a.content, ''), '')"
            : "COALESCE(ab.markdown_content, '')";
        string legacyGroupBy = hasLegacyContentColumn ? ", a.content" : string.Empty;
        string sql = $$"""
            SELECT
                a.id AS "Id",
                a.title AS "Title",
                a.summary AS "Summary",
                a.coverimageurl AS "CoverImageUrl",
                a.categoryid AS "CategoryId",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt",
                c.name AS "CategoryName",
                {{contentExpression}} AS "Content",
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
            LEFT JOIN category c ON a.categoryid = c.id
            LEFT JOIN article_body ab ON ab.article_id = a.id
            LEFT JOIN LATERAL (
                SELECT snapshot.*
                FROM article_rights_snapshot snapshot
                WHERE snapshot.article_id = a.id
                ORDER BY snapshot.revision_no DESC, snapshot.created_at DESC, snapshot.id DESC
                LIMIT 1
            ) rights ON TRUE
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = rights.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE
            LEFT JOIN article_tag at ON at.articleid = a.id
            LEFT JOIN tag t ON t.id = at.tagid
            WHERE a.id = @Id
              AND a.isdeleted = false
              AND a.status = @PublishedStatus
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
            GROUP BY
                a.id,
                a.title,
                a.summary,
                a.coverimageurl,
                a.categoryid,
                a.views,
                a.createtime,
                a.isdeleted,
                a.status,
                a.scheduled_publish_at,
                a.published_at,
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
                rights_proof.proof_status,
                ab.markdown_content{{legacyGroupBy}};
            """;
        ArticleDetailReadModel? article = null;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            sql,
            new SugarParameter("@Id", id),
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
                int fCatName = reader.GetOrdinal("CategoryName");
                int fContent = reader.GetOrdinal("Content");
                int fTagIds = reader.GetOrdinal("TagIds");
                int fTagNames = reader.GetOrdinal("TagNames");
                string content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent);
                string summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum);
                if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(summary))
                {
                    content = summary;
                }

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

        if (!string.IsNullOrWhiteSpace(content) || !await LegacyArticleContentColumnExistsAsync().ConfigureAwait(false))
        {
            return content;
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(content, '') AS content FROM article WHERE id = @id LIMIT 1;",
            new[] { new SugarParameter("@id", articleId) });
        if (await reader.ReadAsync(ct).ConfigureAwait(false) && !reader.IsDBNull(0))
        {
            return reader.GetString(0);
        }

        return string.Empty;
    }

    private async Task<bool> LegacyArticleContentColumnExistsAsync()
    {
        if (legacyArticleContentColumnExists.HasValue)
        {
            return legacyArticleContentColumnExists.Value;
        }

        int exists = await db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM information_schema.columns
            WHERE table_name = 'article'
              AND column_name = 'content';
            """);
        legacyArticleContentColumnExists = exists > 0;
        return legacyArticleContentColumnExists.Value;
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
