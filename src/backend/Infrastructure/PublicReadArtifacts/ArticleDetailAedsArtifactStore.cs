using System.Collections.Concurrent;
using System.Diagnostics;
using System.Buffers.Binary;
using System.Data.Common;
using System.Threading.Channels;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
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

public sealed class ArticleDetailAedsFileArtifactStore(
    IWebHostEnvironment env,
    ILogger<ArticleDetailAedsFileArtifactStore> logger) : IArticleDetailAedsArtifactStore
{
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

    private static bool LooksLikeAedsArticleDetailFrame(ReadOnlySpan<byte> frame)
    {
        if (frame.Length < AedsFrameHeader.Size)
        {
            return false;
        }

        return BinaryPrimitives.ReadUInt32LittleEndian(frame[..4]) == AedsEncoder.Magic
            && frame[4] == AedsFrameHeader.CurrentVersion
            && frame[5] == AedsFrameHeader.Size
            && BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]) == (ushort)AedsFrameType.ArticleDetail;
    }

    private sealed record CachedFrame(byte[] Frame, DateTimeOffset ExpiresAtUtc);
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
    IArticleDetailAedsArtifactStore store) : IArticleDetailAedsArtifactProjector
{
    private const int LongReadThreshold = 5_000;
    private const int ReadingCharsPerMinute = 300;

    private bool? legacyArticleContentColumnExists;

    public async Task GenerateAndStoreAsync(int articleId, CancellationToken cancellationToken = default)
    {
        ArticleDetailReadModel? article = await LoadArticleDetailFromDbAsync(articleId, cancellationToken).ConfigureAwait(false);
        if (article is null)
        {
            await store.RemoveAsync(articleId, cancellationToken).ConfigureAwait(false);
            return;
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

                int wordCount = CalculateReadableLength(content);

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
                    WordCount = wordCount,
                    EstimatedReadingMinutes = Math.Max(1, (wordCount + ReadingCharsPerMinute - 1) / ReadingCharsPerMinute),
                    ShowReadingNotice = wordCount > LongReadThreshold,
                    Tags = ReadArticleDetailTags(reader, fTagIds, fTagNames)
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

    private static int CalculateReadableLength(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return 0;
        }

        int count = 0;
        foreach (char ch in content)
        {
            if (!char.IsWhiteSpace(ch))
            {
                count++;
            }
        }

        return count;
    }
}
