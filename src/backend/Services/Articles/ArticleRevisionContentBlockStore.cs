using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Data;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public readonly record struct ArticleRevisionContentReachability(
    long RevisionCount,
    long ContentBlockCount,
    long ReachableContentBlockCount,
    long MissingReferenceCount,
    long OrphanContentBlockCount);

public interface IArticleRevisionContentBlockMaintenance
{
    Task<ArticleRevisionContentReachability> CheckReachabilityAsync(CancellationToken cancellationToken = default);

    Task<int> DeleteUnreferencedAsync(DateTime createdBeforeUtc, CancellationToken cancellationToken = default);
}

public sealed class ArticleRevisionContentBlockMaintenance(ISqlSugarClient db)
    : IArticleRevisionContentBlockMaintenance
{
    public Task<ArticleRevisionContentReachability> CheckReachabilityAsync(
        CancellationToken cancellationToken = default)
        => ArticleRevisionContentBlockStore.CheckReachabilityAsync(db, cancellationToken);

    public Task<int> DeleteUnreferencedAsync(
        DateTime createdBeforeUtc,
        CancellationToken cancellationToken = default)
        => ArticleRevisionContentBlockStore.DeleteUnreferencedAsync(db, createdBeforeUtc, cancellationToken);
}

public static class ArticleRevisionContentBlockStore
{
    public static async Task<long> GetOrCreateAsync(
        ISqlSugarClient db,
        string markdownContent,
        DateTime createdAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleRevisionContentAddress address = ArticleRevisionContentAddress.Compute(markdownContent);
        string content = address.MarkdownContent;
        string hash = address.ContentHash;

        // Content blocks are immutable and may outlive a rolled-back revision transaction.
        // Committing the block independently prevents unrelated article transactions that use
        // the same Markdown from blocking on the global hash uniqueness constraint; the
        // reachability cleanup removes blocks left orphaned by a later revision rollback.
        using SqlSugarClient blockDb = db.CopyNew();
        using var reader = (DbDataReader)await blockDb.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_revision_content_block(content_hash, markdown_content, byte_length, created_at)
            VALUES (@ContentHash, @MarkdownContent, @ByteLength, @CreatedAt)
            ON CONFLICT (content_hash) DO UPDATE
            SET content_hash = EXCLUDED.content_hash
            WHERE article_revision_content_block.markdown_content = EXCLUDED.markdown_content
            RETURNING id;
            """,
            new SugarParameter("@ContentHash", hash),
            new SugarParameter("@MarkdownContent", content),
            new SugarParameter("@ByteLength", address.ByteLength),
            new SugarParameter("@CreatedAt", createdAtUtc));
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return reader.ReadInt64("id");
        }

        throw new InvalidOperationException("article_revision_content_hash_collision");
    }

    public static async Task<string> LoadAsync(
        ISqlSugarClient db,
        long contentBlockId,
        CancellationToken cancellationToken)
    {
        if (contentBlockId <= 0)
        {
            throw new InvalidOperationException($"article_revision_content_block_missing:{contentBlockId}");
        }

        string? content = await db.Queryable<ArticleRevisionContentBlock>()
            .Where(block => block.Id == contentBlockId)
            .Select(block => block.MarkdownContent)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        return content ?? throw new InvalidOperationException(
            $"article_revision_content_block_missing:{contentBlockId}");
    }

    public static async Task<IReadOnlyDictionary<long, string>> HydrateAsync(
        ISqlSugarClient db,
        IReadOnlyCollection<ArticleRevision> revisions,
        CancellationToken cancellationToken)
    {
        if (revisions.Count == 0)
        {
            return new Dictionary<long, string>();
        }

        foreach (ArticleRevision revision in revisions)
        {
            if (revision.ContentBlockId <= 0)
            {
                throw new InvalidOperationException(
                    $"article_revision_content_block_missing:{revision.Id}:{revision.ContentBlockId}");
            }
        }

        long[] ids = [.. revisions.Select(static revision => revision.ContentBlockId).Distinct()];
        Dictionary<long, string> contentById = (await db.Queryable<ArticleRevisionContentBlock>()
                .Where(block => ids.Contains(block.Id))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .ToDictionary(static block => block.Id, static block => block.MarkdownContent);
        foreach (ArticleRevision revision in revisions)
        {
            if (!contentById.TryGetValue(revision.ContentBlockId, out string? content) || content is null)
            {
                throw new InvalidOperationException(
                    $"article_revision_content_block_missing:{revision.Id}:{revision.ContentBlockId}");
            }
        }

        // Loaded bytes belong to the read operation, never to an ORM column or a writable entity.
        return contentById;
    }

    public static async Task<ArticleRevisionContentReachability> CheckReachabilityAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                (SELECT COUNT(*) FROM article_revision) AS revision_count,
                (SELECT COUNT(*) FROM article_revision_content_block) AS block_count,
                (SELECT COUNT(DISTINCT content_block_id) FROM article_revision WHERE content_block_id IS NOT NULL) AS reachable_count,
                (SELECT COUNT(*) FROM article_revision revision
                    LEFT JOIN article_revision_content_block block ON block.id = revision.content_block_id
                    WHERE block.id IS NULL) AS missing_count,
                (SELECT COUNT(*) FROM article_revision_content_block block
                    WHERE NOT EXISTS (SELECT 1 FROM article_revision revision WHERE revision.content_block_id = block.id)) AS orphan_count;
            """);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return new ArticleRevisionContentReachability(
            reader.ReadInt64("revision_count"),
            reader.ReadInt64("block_count"),
            reader.ReadInt64("reachable_count"),
            reader.ReadInt64("missing_count"),
            reader.ReadInt64("orphan_count"));
    }

    public static Task<int> DeleteUnreferencedAsync(
        ISqlSugarClient db,
        DateTime createdBeforeUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM article_revision_content_block block
            WHERE block.created_at < @CreatedBeforeUtc
              AND NOT EXISTS (
                  SELECT 1 FROM article_revision revision WHERE revision.content_block_id = block.id
              );
            """,
            new SugarParameter("@CreatedBeforeUtc", createdBeforeUtc));
    }
}
