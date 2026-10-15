using System.Data.Common;
using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IAdminIntegrityOperations
{
    Task<IntegrityReportResponse> InspectAsync(CancellationToken cancellationToken);

    Task<IntegrityFixPreviewResponse> PreviewFixAsync(CancellationToken cancellationToken);

    Task<IntegrityFixResponse> ApplyFixAsync(IntegrityFixRequest request, CancellationToken cancellationToken);
}

internal sealed class AdminIntegrityOperations(
    ISqlSugarClient db,
    ReleaseStoragePaths storagePaths) : IAdminIntegrityOperations
{
    private const string IntegrityFixPhrase = "APPLY_SAFE_FIXES";
    private const int MaxUntrackedUploadScanFiles = 10_000;

    public async Task<IntegrityReportResponse> InspectAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<IntegrityCheckResponse> checks = await BuildIntegrityChecksAsync(cancellationToken);

        int issueCount = checks.Count(static item => item.Count > 0);
        return new IntegrityReportResponse(
            issueCount == 0 ? "ok" : "issues",
            DateTimeOffset.UtcNow,
            checks.Count,
            issueCount,
            checks);
    }

    public async Task<IntegrityFixPreviewResponse> PreviewFixAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<AdminDiffResponse> diffs = await BuildSafeFixDiffsAsync(cancellationToken);
        return new IntegrityFixPreviewResponse(
            diffs.Count == 0 ? "empty" : "ready",
            DateTimeOffset.UtcNow,
            diffs,
            $"输入 {IntegrityFixPhrase} 后应用安全修复",
            "admin.integrity.safe_fix_applied");
    }

    public async Task<IntegrityFixResponse> ApplyFixAsync(
        IntegrityFixRequest request,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(request.ConfirmPhrase, IntegrityFixPhrase, StringComparison.Ordinal))
        {
            return new IntegrityFixResponse("confirmation_required", DateTimeOffset.UtcNow, 0, []);
        }

        HashSet<string> codes = request.Codes is { Count: > 0 }
            ? request.Codes.ToHashSet(StringComparer.OrdinalIgnoreCase)
            : ["article_tag_missing_tag", "article_tag_missing_article", "session_deleted_user"];
        List<AdminDiffResponse> diffs = [];

        if (codes.Contains("article_tag_missing_tag") || codes.Contains("article_tag_missing_article"))
        {
            diffs.AddRange(await DeleteInvalidArticleTagsAsync(await QueryInvalidArticleTagsAsync(cancellationToken), cancellationToken));
        }

        if (codes.Contains("session_deleted_user"))
        {
            diffs.AddRange(await RevokeDeletedUserSessionsAsync(await QueryDeletedUserSessionsAsync(cancellationToken), cancellationToken));
        }

        return new IntegrityFixResponse(
            diffs.Count == 0 ? "empty" : "applied",
            DateTimeOffset.UtcNow,
            diffs.Count,
            diffs);
    }

    private async Task<T> QueryWithNewClientAsync<T>(Func<ISqlSugarClient, Task<T>> query)
    {
        using SqlSugarClient queryDb = db.CopyNew();
        return await query(queryDb);
    }

    private IntegrityCheckResponse BuildCheck(
        string code,
        string title,
        IReadOnlyList<string> sampleKeys,
        string severity,
        bool autoFixAvailable,
        string detail)
        => new(
            code,
            title,
            sampleKeys.Count == 0 ? "ok" : "issue",
            sampleKeys.Count == 0 ? "ok" : severity,
            sampleKeys.Count,
            autoFixAvailable && sampleKeys.Count > 0,
            detail,
            sampleKeys.Take(10).ToArray(),
            autoFixAvailable ? sampleKeys.Take(10).Select(key => new AdminDiffResponse(key, "present", "fixed")).ToArray() : []);

    private IntegrityCheckResponse BuildCheck(
        string code,
        string title,
        IntegrityCheckSample sample,
        string severity,
        bool autoFixAvailable,
        string detail)
        => new(
            code,
            title,
            sample.Count == 0 ? "ok" : "issue",
            sample.Count == 0 ? "ok" : severity,
            sample.Count,
            autoFixAvailable && sample.Count > 0,
            sample.ScannedFileCount > 0 ? $"{detail} scannedFiles={sample.ScannedFileCount}" : detail,
            sample.SampleKeys,
            autoFixAvailable ? sample.SampleKeys.Select(key => new AdminDiffResponse(key, "present", "fixed")).ToArray() : []);

    private async Task<IReadOnlyList<IntegrityCheckResponse>> BuildIntegrityChecksAsync(CancellationToken cancellationToken)
    {
        IntegrityCheckSample missingBody = await RunIntegritySqlCheckAsync("article_missing_body", $$"""
            SELECT 'article:' || a.id AS sample_key
            FROM article a
            LEFT JOIN article_body b ON b.article_id = a.id
            WHERE a.status = {{(int)ArticleStatus.Published}}
              AND (b.article_id IS NULL OR b.markdown_content IS NULL OR btrim(b.markdown_content) = '')
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample invalidCurrentRevision = await RunIntegritySqlCheckAsync("article_current_revision_invalid", $$"""
            SELECT 'article:' || a.id || ':revision:' || COALESCE(a.current_revision_id::text, 'null') AS sample_key
            FROM article a
            LEFT JOIN article_revision r
              ON r.id = a.current_revision_id
             AND r.article_id = a.id
            WHERE a.status <> {{(int)ArticleStatus.Deleted}}
              AND (a.current_revision_id IS NULL OR r.id IS NULL)
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample invalidCurrentPublication = await RunIntegritySqlCheckAsync("article_current_publication_invalid", $$"""
            SELECT 'article:' || a.id || ':publication:' || COALESCE(a.current_publication_id::text, 'null') AS sample_key
            FROM article a
            LEFT JOIN article_publication p
              ON p.id = a.current_publication_id
             AND p.article_id = a.id
            LEFT JOIN article_revision r
              ON r.id = p.article_revision_id
             AND r.article_id = a.id
            WHERE a.status = {{(int)ArticleStatus.Published}}
              AND (a.current_publication_id IS NULL OR p.id IS NULL OR r.id IS NULL)
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample bodyRevisionMismatch = await RunIntegritySqlCheckAsync("article_body_revision_mismatch", $$"""
            SELECT 'article:' || a.id || ':revision:' || COALESCE(a.current_revision_id::text, 'null') AS sample_key
            FROM article a
            JOIN article_body b ON b.article_id = a.id
            LEFT JOIN article_revision r
              ON r.id = a.current_revision_id
             AND r.article_id = a.id
            LEFT JOIN article_revision_content_block block ON block.id = r.content_block_id
            WHERE a.status = {{(int)ArticleStatus.Published}}
              AND b.markdown_content IS NOT NULL
              AND btrim(b.markdown_content) <> ''
              AND (r.id IS NULL
                OR r.content_block_id IS NULL
                OR r.content_block_id <= 0
                OR block.id IS NULL
                OR block.markdown_content IS NULL
                OR b.markdown_content IS DISTINCT FROM block.markdown_content)
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample bodyWithoutRevision = await RunIntegritySqlCheckAsync("article_body_without_revision", """
            SELECT 'article:' || b.article_id AS sample_key
            FROM article_body b
            LEFT JOIN article_revision r ON r.article_id = b.article_id
            WHERE r.article_id IS NULL
            ORDER BY b.article_id
            """, cancellationToken);
        IntegrityCheckSample missingCategory = await RunIntegritySqlCheckAsync("article_missing_category", $$"""
            SELECT 'article:' || a.id || ':category:' || a.categoryid AS sample_key
            FROM article a
            LEFT JOIN category c ON c.id = a.categoryid
            WHERE a.status <> {{(int)ArticleStatus.Deleted}}
              AND c.id IS NULL
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample missingTag = await RunIntegritySqlCheckAsync("article_tag_missing_tag", """
            SELECT 'article_tag:' || at.articleid || ':' || at.tagid AS sample_key
            FROM article_tag at
            LEFT JOIN tag t ON t.id = at.tagid
            WHERE t.id IS NULL
            ORDER BY at.articleid, at.tagid
            """, cancellationToken);
        IntegrityCheckSample missingTagArticle = await RunIntegritySqlCheckAsync("article_tag_missing_article", """
            SELECT 'article_tag:' || at.articleid || ':' || at.tagid AS sample_key
            FROM article_tag at
            LEFT JOIN article a ON a.id = at.articleid
            WHERE a.id IS NULL
            ORDER BY at.articleid, at.tagid
            """, cancellationToken);
        IntegrityCheckSample missingCommentArticle = await RunIntegritySqlCheckAsync("comment_missing_article", """
            SELECT 'comment:' || c.id || ':article:' || c.article_id AS sample_key
            FROM comment c
            LEFT JOIN article a ON a.id = c.article_id
            WHERE a.id IS NULL
            ORDER BY c.id
            """, cancellationToken);
        IntegrityCheckSample invalidCommentChain = await RunIntegritySqlCheckAsync("comment_chain_invalid", """
            SELECT 'comment:' || c.id AS sample_key
            FROM comment c
            LEFT JOIN comment p ON p.id = c.parent_id
            LEFT JOIN comment r ON r.id = c.root_id
            WHERE (c.parent_id IS NOT NULL AND c.parent_id > 0 AND p.id IS NULL)
               OR (c.root_id IS NOT NULL AND c.root_id > 0 AND r.id IS NULL)
            ORDER BY c.id
            """, cancellationToken);
        IntegrityCheckSample deletedUserSessions = await RunIntegritySqlCheckAsync("session_deleted_user", """
            SELECT 'session:' || s.sessionid || ':user:' || s.userid AS sample_key
            FROM sys_user_session s
            LEFT JOIN sys_user u ON u.id = s.userid
            WHERE s.revokedat IS NULL
              AND (u.id IS NULL OR u.status = 2 OR u.deleted_at IS NOT NULL)
            ORDER BY s.sessionid
            """, cancellationToken);
        IntegrityCheckSample untrackedUploads = await BuildUntrackedUploadsCheckAsync(cancellationToken);
        IntegrityCheckSample missingAssetFiles = await BuildMissingAssetFilesCheckAsync(cancellationToken);

        return
        [
            BuildCheck("article_missing_body", "文章正文缺失或为空", missingBody, "error", true, "发布文章会进入本机正文修复队列；修复后重建缓存与公开产物。"),
            BuildCheck("article_current_revision_invalid", "文章 current revision 指针异常", invalidCurrentRevision, "error", false, "需要恢复当前 revision 指针后再执行正文修复。"),
            BuildCheck("article_current_publication_invalid", "发布文章 current publication 指针异常", invalidCurrentPublication, "error", false, "需要恢复 publication 与 revision 关系后再重建公开产物。"),
            BuildCheck("article_body_revision_mismatch", "正文与 current revision 不一致", bodyRevisionMismatch, "warning", false, "需要人工确认 current revision 后再覆盖正文。"),
            BuildCheck("article_body_without_revision", "正文缺少 revision", bodyWithoutRevision, "warning", false, "需要人工确认首个 revision 的正文来源。"),
            BuildCheck("article_missing_category", "文章引用不存在分类", missingCategory, "error", false, "需要重新指定分类或恢复分类。"),
            BuildCheck("article_tag_missing_tag", "文章标签关联不存在 tag", missingTag, "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("article_tag_missing_article", "标签关联不存在文章", missingTagArticle, "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("comment_missing_article", "评论指向不存在文章", missingCommentArticle, "error", false, "需要人工确认评论是否删除或迁移。"),
            BuildCheck("comment_chain_invalid", "评论 root/parent 链异常", invalidCommentChain, "warning", false, "需要人工判断楼层结构。"),
            BuildCheck("session_deleted_user", "session 指向已注销用户", deletedUserSessions, "warning", true, "安全修复会撤销这些 session。"),
            BuildCheck("upload_untracked", "uploads 文件未进 asset library", untrackedUploads, "info", false, "可通过文章资产重建补齐。"),
            BuildCheck("asset_missing_file", "asset library 指向不存在文件", missingAssetFiles, "warning", false, "需要人工确认是否清理资产记录。"),
            BuildCheck("sitemap_visibility", "sitemap 公开性", new IntegrityCheckSample(0, []), "info", false, "sitemap 文章、分类、标签均复用 published visibility 过滤。"),
            BuildCheck("search_visibility", "搜索公开性", new IntegrityCheckSample(0, []), "info", false, "SearchIndexService 只加载 published 且已到发布时间的文章。"),
            BuildCheck("taxonomy_count_runtime", "taxonomy 公开计数", new IntegrityCheckSample(0, []), "info", false, "后台 taxonomy 计数实时聚合，不依赖易漂移的持久计数字段。")
        ];
    }

    private async Task<IntegrityCheckSample> RunIntegritySqlCheckAsync(string code, string issueSql, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        int count = await db.Ado.GetIntAsync($"SELECT COUNT(*) FROM ({issueSql}) AS integrity_issues;");
        var sampleKeys = new List<string>(Math.Min(10, Math.Max(0, count)));
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync($"SELECT sample_key FROM ({issueSql}) AS integrity_issues LIMIT 10;");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            sampleKeys.Add(reader.IsDBNull(0) ? string.Empty : reader.GetString(0));
        }

        IntegrityCheckSample sample = new(count, sampleKeys);
        FsusObservability.RecordAdminIntegrityCheck(code, FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<IntegrityCheckSample> BuildUntrackedUploadsCheckAsync(CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        string uploadRoot = storagePaths.PublicAssetRoot;
        if (!Directory.Exists(uploadRoot))
        {
            IntegrityCheckSample empty = new(0, []);
            FsusObservability.RecordAdminIntegrityCheck("upload_untracked", FsusObservability.GetElapsed(started), empty.Count, empty.SampleKeys.Count, empty.ScannedFileCount);
            return empty;
        }

        HashSet<string> assetUrls = await LoadAssetUrlSetAsync(cancellationToken);
        var samples = new List<string>(10);
        int count = 0;
        int scanned = 0;
        foreach (string path in EnumerateUploadFilesBounded(uploadRoot, MaxUntrackedUploadScanFiles))
        {
            cancellationToken.ThrowIfCancellationRequested();
            scanned++;
            string url = "/uploads/" + Path.GetRelativePath(uploadRoot, path).Replace(Path.DirectorySeparatorChar, '/');
            if (assetUrls.Contains(url))
            {
                continue;
            }

            count++;
            if (samples.Count < 10)
            {
                samples.Add(url);
            }
        }

        IntegrityCheckSample sample = new(count, samples, scanned);
        FsusObservability.RecordAdminIntegrityCheck("upload_untracked", FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<IntegrityCheckSample> BuildMissingAssetFilesCheckAsync(CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        List<ContentAsset> records = await db.Queryable<ContentAsset>()
            .Where(asset => asset.StorageClass == "public")
            .ToListAsync(cancellationToken);
        List<IntegrityAssetRow> assets = [.. records.Select(static asset => new IntegrityAssetRow
        {
            Id = asset.AssetId.ToString("D"),
            Url = PublicAssetUrlCodec.RoutePrefix + asset.StorageKey
        })];
        string publicAssetRoot = storagePaths.PublicAssetRoot;
        var samples = new List<string>(10);
        int count = 0;
        foreach (IntegrityAssetRow asset in assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryResolveUploadPath(publicAssetRoot, asset.Url, out string path) || !File.Exists(path))
            {
                count++;
                if (samples.Count < 10)
                {
                    samples.Add($"asset:{asset.Id}:{asset.Url}");
                }
            }
        }

        IntegrityCheckSample sample = new(count, samples, assets.Count);
        FsusObservability.RecordAdminIntegrityCheck("asset_missing_file", FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<HashSet<string>> LoadAssetUrlSetAsync(CancellationToken cancellationToken)
    {
        List<string> storageKeys = await db.Queryable<ContentAsset>()
            .Where(asset => asset.StorageClass == "public")
            .Select(asset => asset.StorageKey)
            .ToListAsync(cancellationToken);
        return storageKeys
            .Select(static key => PublicAssetUrlCodec.RoutePrefix + key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private async Task<IntegrityData> LoadIntegrityDataAsync(CancellationToken cancellationToken)
    {
        Task<List<IntegrityArticleRow>> articlesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Article>()
            .Select(article => new IntegrityArticleRow
            {
                Id = article.Id,
                CategoryId = article.CategoryId,
                Status = article.Status
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleBodyRow>> bodiesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleBody>()
            .Select(body => new IntegrityArticleBodyRow { ArticleId = body.ArticleId })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleRevisionRow>> revisionsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleRevision>()
            .Select(revision => new IntegrityArticleRevisionRow { ArticleId = revision.ArticleId })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityCategoryRow>> categoriesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Category>()
            .Select(category => new IntegrityCategoryRow { Id = category.Id })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityTagRow>> tagsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Tag>()
            .Select(tag => new IntegrityTagRow { Id = tag.Id })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleTagRow>> articleTagsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleTag>()
            .Select(tag => new IntegrityArticleTagRow
            {
                ArticleId = tag.ArticleId,
                TagId = tag.TagId
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityCommentRow>> commentsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Comment>()
            .Select(comment => new IntegrityCommentRow
            {
                Id = comment.Id,
                ArticleId = comment.ArticleId,
                ParentId = comment.ParentId,
                RootId = comment.RootId
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityUserRow>> usersTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<User>()
            .Select(user => new IntegrityUserRow
            {
                Id = user.Id,
                Status = user.Status,
                DeletedAt = user.DeletedAt
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegritySessionRow>> sessionsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<UserSession>()
            .Select(session => new IntegritySessionRow
            {
                SessionId = session.SessionId,
                UserId = session.UserId,
                RevokedAt = session.RevokedAt
            })
            .ToListAsync(cancellationToken));
        Task<List<ContentAsset>> assetsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ContentAsset>()
            .Where(asset => asset.StorageClass == "public")
            .ToListAsync(cancellationToken));
        List<IntegrityArticleRow> articles = await articlesTask;
        List<IntegrityArticleBodyRow> bodies = await bodiesTask;
        List<IntegrityArticleRevisionRow> revisions = await revisionsTask;
        List<IntegrityCategoryRow> categories = await categoriesTask;
        List<IntegrityTagRow> tags = await tagsTask;
        List<IntegrityArticleTagRow> articleTags = await articleTagsTask;
        List<IntegrityCommentRow> comments = await commentsTask;
        List<IntegrityUserRow> users = await usersTask;
        List<IntegritySessionRow> sessions = await sessionsTask;
        List<IntegrityAssetRow> assets = [.. (await assetsTask).Select(static asset => new IntegrityAssetRow
        {
            Id = asset.AssetId.ToString("D"),
            Url = PublicAssetUrlCodec.RoutePrefix + asset.StorageKey
        })];

        string publicAssetRoot = storagePaths.PublicAssetRoot;

        return new IntegrityData(
            articles,
            bodies,
            revisions,
            categories,
            tags,
            articleTags,
            comments,
            users,
            sessions,
            assets,
            publicAssetRoot);
    }

    private static IReadOnlyList<string> MissingBody(IntegrityData data)
        => data.Articles
            .Where(article => article.Status != ArticleStatus.Deleted && !data.BodyArticleIds.Contains(article.Id))
            .Select(article => $"article:{article.Id}")
            .ToArray();

    private static IReadOnlyList<string> BodyWithoutRevision(IntegrityData data)
        => data.Bodies
            .Where(body => !data.RevisionArticleIds.Contains(body.ArticleId))
            .Select(body => $"article:{body.ArticleId}")
            .ToArray();

    private static IReadOnlyList<string> MissingCategory(IntegrityData data)
        => data.Articles
            .Where(article => article.Status != ArticleStatus.Deleted && !data.CategoryIds.Contains(article.CategoryId))
            .Select(article => $"article:{article.Id}:category:{article.CategoryId}")
            .ToArray();

    private static IReadOnlyList<string> MissingArticleTag(IntegrityData data)
        => data.ArticleTags
            .Where(tag => !data.TagIds.Contains(tag.TagId))
            .Select(tag => $"article_tag:{tag.ArticleId}:{tag.TagId}")
            .ToArray();

    private static IReadOnlyList<string> MissingArticleTagArticle(IntegrityData data)
        => data.ArticleTags
            .Where(tag => !data.ArticleIds.Contains(tag.ArticleId))
            .Select(tag => $"article_tag:{tag.ArticleId}:{tag.TagId}")
            .ToArray();

    private static IReadOnlyList<string> MissingCommentArticle(IntegrityData data)
        => data.Comments
            .Where(comment => !data.ArticleIds.Contains(comment.ArticleId))
            .Select(comment => $"comment:{comment.Id}:article:{comment.ArticleId}")
            .ToArray();

    private static IReadOnlyList<string> InvalidCommentChain(IntegrityData data)
        => data.Comments
            .Where(comment => (comment.ParentId is > 0 && !data.CommentIds.Contains(comment.ParentId.Value))
                || (comment.RootId is > 0 && !data.CommentIds.Contains(comment.RootId.Value)))
            .Select(comment => $"comment:{comment.Id}")
            .ToArray();

    private static IReadOnlyList<string> DeletedUserSessions(IntegrityData data)
        => data.Sessions
            .Where(session => data.DeletedOrMissingUserIds.Contains(session.UserId) && session.RevokedAt is null)
            .Select(session => $"session:{session.SessionId}:user:{session.UserId}")
            .ToArray();

    private static IReadOnlyList<string> MissingAssetFiles(IntegrityData data)
        => data.Assets
            .Where(asset => IsUploadUrl(asset.Url) &&
                (!TryResolveUploadPath(data.PublicAssetRoot, asset.Url, out string path) || !File.Exists(path)))
            .Select(asset => $"asset:{asset.Id}:{asset.Url}")
            .ToArray();

    private static IReadOnlyList<string> UntrackedUploads(IntegrityData data)
    {
        string uploadRoot = data.PublicAssetRoot;
        if (!Directory.Exists(uploadRoot))
        {
            return [];
        }

        HashSet<string> assetUrls = data.Assets
            .Select(static asset => asset.Url)
            .Where(static url => !string.IsNullOrWhiteSpace(url))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return EnumerateUploadFilesBounded(uploadRoot, MaxUntrackedUploadScanFiles)
            .Select(path => "/uploads/" + Path.GetRelativePath(uploadRoot, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(url => !assetUrls.Contains(url))
            .Take(1000)
            .ToArray();
    }

    private async Task<IReadOnlyList<AdminDiffResponse>> BuildSafeFixDiffsAsync(CancellationToken cancellationToken)
    {
        List<IntegrityArticleTagRow> invalidTags = await QueryInvalidArticleTagsAsync(cancellationToken);
        List<IntegritySessionRow> sessions = await QueryDeletedUserSessionsAsync(cancellationToken);
        var diffs = new List<AdminDiffResponse>(invalidTags.Count + sessions.Count);
        diffs.AddRange(invalidTags.Select(tag => new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted")));
        diffs.AddRange(sessions.Select(session => new AdminDiffResponse($"session:{session.SessionId}", "active", "revoked")));
        return diffs;
    }

    private async Task<List<IntegrityArticleTagRow>> QueryInvalidArticleTagsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT at.articleid AS "ArticleId", at.tagid AS "TagId"
            FROM article_tag at
            LEFT JOIN tag t ON t.id = at.tagid
            LEFT JOIN article a ON a.id = at.articleid
            WHERE t.id IS NULL OR a.id IS NULL
            ORDER BY at.articleid, at.tagid;
            """);
        var result = new List<IntegrityArticleTagRow>();
        int fArticleId = reader.GetOrdinal("ArticleId");
        int fTagId = reader.GetOrdinal("TagId");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new IntegrityArticleTagRow
            {
                ArticleId = reader.GetInt32(fArticleId),
                TagId = reader.GetInt32(fTagId)
            });
        }

        return result;
    }

    private async Task<List<IntegritySessionRow>> QueryDeletedUserSessionsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT s.sessionid AS "SessionId", s.userid AS "UserId", s.revokedat AS "RevokedAt"
            FROM sys_user_session s
            LEFT JOIN sys_user u ON u.id = s.userid
            WHERE s.revokedat IS NULL
              AND (u.id IS NULL OR u.status = 2 OR u.deleted_at IS NOT NULL)
            ORDER BY s.sessionid;
            """);
        var result = new List<IntegritySessionRow>();
        int fSessionId = reader.GetOrdinal("SessionId");
        int fUserId = reader.GetOrdinal("UserId");
        int fRevokedAt = reader.GetOrdinal("RevokedAt");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new IntegritySessionRow
            {
                SessionId = reader.GetString(fSessionId),
                UserId = reader.GetInt32(fUserId),
                RevokedAt = reader.IsDBNull(fRevokedAt) ? null : reader.GetDateTime(fRevokedAt)
            });
        }

        return result;
    }

    private static IReadOnlyList<AdminDiffResponse> BuildSafeFixDiffs(IntegrityData data)
    {
        List<AdminDiffResponse> diffs = [];
        diffs.AddRange(data.ArticleTags
            .Where(tag => !data.TagIds.Contains(tag.TagId) || !data.ArticleIds.Contains(tag.ArticleId))
            .Select(tag => new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted")));
        diffs.AddRange(data.Sessions
            .Where(session => data.DeletedOrMissingUserIds.Contains(session.UserId) && session.RevokedAt is null)
            .Select(session => new AdminDiffResponse($"session:{session.SessionId}", "active", "revoked")));
        return diffs;
    }

    private async Task<IReadOnlyList<AdminDiffResponse>> DeleteInvalidArticleTagsAsync(
        IReadOnlyList<IntegrityArticleTagRow> invalidTags,
        CancellationToken cancellationToken)
    {
        if (invalidTags.Count == 0)
        {
            return [];
        }

        var diffs = new List<AdminDiffResponse>(invalidTags.Count);
        for (int i = 0; i < invalidTags.Count; i++)
        {
            IntegrityArticleTagRow tag = invalidTags[i];
            diffs.Add(new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted"));
        }

        const int BatchSize = 500;
        for (int offset = 0; offset < invalidTags.Count; offset += BatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count = Math.Min(BatchSize, invalidTags.Count - offset);
            await DeleteArticleTagBatchAsync(invalidTags, offset, count);
        }

        return diffs;
    }

    private async Task DeleteArticleTagBatchAsync(
        IReadOnlyList<IntegrityArticleTagRow> tags,
        int offset,
        int count)
    {
        var sql = new StringBuilder("DELETE FROM article_tag WHERE ");
        var parameters = new List<SugarParameter>(count * 2);
        for (int i = 0; i < count; i++)
        {
            if (i > 0)
            {
                sql.Append(" OR ");
            }

            int parameterIndex = offset + i;
            string articleParameter = $"@article_id_{parameterIndex}";
            string tagParameter = $"@tag_id_{parameterIndex}";
            sql.Append("(articleid = ")
                .Append(articleParameter)
                .Append(" AND tagid = ")
                .Append(tagParameter)
                .Append(')');
            IntegrityArticleTagRow tag = tags[parameterIndex];
            parameters.Add(new SugarParameter(articleParameter, tag.ArticleId));
            parameters.Add(new SugarParameter(tagParameter, tag.TagId));
        }

        await db.Ado.ExecuteCommandAsync(sql.ToString(), parameters.ToArray());
    }

    private async Task<IReadOnlyList<AdminDiffResponse>> RevokeDeletedUserSessionsAsync(
        IReadOnlyList<IntegritySessionRow> sessions,
        CancellationToken cancellationToken)
    {
        if (sessions.Count == 0)
        {
            return [];
        }

        var diffs = new List<AdminDiffResponse>(sessions.Count);
        for (int i = 0; i < sessions.Count; i++)
        {
            diffs.Add(new AdminDiffResponse($"session:{sessions[i].SessionId}", "active", "revoked"));
        }

        DateTime now = DateTime.UtcNow;
        const int BatchSize = 500;
        for (int offset = 0; offset < sessions.Count; offset += BatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string[] sessionIds = sessions
                .Skip(offset)
                .Take(Math.Min(BatchSize, sessions.Count - offset))
                .Select(static session => session.SessionId)
                .ToArray();
            await db.Updateable<UserSession>()
                .SetColumns(item => item.RevokedAt == now)
                .SetColumns(item => item.RevokeReason == "integrity_safe_fix_deleted_user")
                .Where(item => sessionIds.Contains(item.SessionId))
                .ExecuteCommandAsync(cancellationToken);
        }

        return diffs;
    }

    private static bool IsUploadUrl(string? url)
        => !string.IsNullOrWhiteSpace(url) && url.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> EnumerateUploadFilesBounded(string uploadRoot, int maxFiles)
    {
        if (maxFiles <= 0)
        {
            yield break;
        }

        var pending = new Stack<string>();
        pending.Push(uploadRoot);
        int yielded = 0;
        while (pending.Count > 0 && yielded < maxFiles)
        {
            string current = pending.Pop();
            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(current);
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (string file in files)
            {
                if (yielded >= maxFiles)
                {
                    yield break;
                }

                yielded++;
                yield return file;
            }

            IEnumerable<string> directories;
            try
            {
                directories = Directory.EnumerateDirectories(current);
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (string directory in directories)
            {
                pending.Push(directory);
            }
        }
    }

    private static bool TryResolveUploadPath(string publicAssetRoot, string url, out string path)
    {
        path = string.Empty;
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        string normalizedUrl = url.Trim().Replace('\\', '/');
        const string UploadPrefix = "/uploads/";
        if (!normalizedUrl.StartsWith(UploadPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return CanonicalPathBoundary.TryResolveRelative(
            publicAssetRoot,
            normalizedUrl[UploadPrefix.Length..],
            out path);
    }

    private sealed record IntegrityData(
        List<IntegrityArticleRow> Articles,
        List<IntegrityArticleBodyRow> Bodies,
        List<IntegrityArticleRevisionRow> Revisions,
        List<IntegrityCategoryRow> Categories,
        List<IntegrityTagRow> Tags,
        List<IntegrityArticleTagRow> ArticleTags,
        List<IntegrityCommentRow> Comments,
        List<IntegrityUserRow> Users,
        List<IntegritySessionRow> Sessions,
        List<IntegrityAssetRow> Assets,
        string PublicAssetRoot)
    {
        public HashSet<int> ArticleIds { get; } = Articles.Select(static item => item.Id).ToHashSet();
        public HashSet<int> BodyArticleIds { get; } = Bodies.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> RevisionArticleIds { get; } = Revisions.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> CategoryIds { get; } = Categories.Select(static item => item.Id).ToHashSet();
        public HashSet<int> TagIds { get; } = Tags.Select(static item => item.Id).ToHashSet();
        public HashSet<long> CommentIds { get; } = Comments.Select(static item => item.Id).ToHashSet();

        private HashSet<int>? _activeUserIds;
        private HashSet<int>? _deletedOrMissingUserIds;

        public HashSet<int> ActiveUserIds => _activeUserIds ??= Users
            .Where(static user => user.Status != 2 && user.DeletedAt is null)
            .Select(static user => user.Id)
            .ToHashSet();

        public HashSet<int> DeletedOrMissingUserIds => _deletedOrMissingUserIds ??= Sessions
            .Select(static session => session.UserId)
            .Where(userId => !ActiveUserIds.Contains(userId))
            .ToHashSet();
    }

    private sealed record IntegrityCheckSample(
        int Count,
        IReadOnlyList<string> SampleKeys,
        int ScannedFileCount = 0);

    private sealed class IntegrityArticleRow
    {
        public int Id
        {
            get; init;
        }

        public int CategoryId
        {
            get; init;
        }

        public ArticleStatus Status
        {
            get; init;
        }
    }

    private sealed class IntegrityArticleBodyRow
    {
        public int ArticleId
        {
            get; init;
        }
    }

    private sealed class IntegrityArticleRevisionRow
    {
        public int ArticleId
        {
            get; init;
        }
    }

    private sealed class IntegrityCategoryRow
    {
        public int Id
        {
            get; init;
        }
    }

    private sealed class IntegrityTagRow
    {
        public int Id
        {
            get; init;
        }
    }

    private sealed class IntegrityArticleTagRow
    {
        public int ArticleId
        {
            get; init;
        }

        public int TagId
        {
            get; init;
        }
    }

    private sealed class IntegrityCommentRow
    {
        public long Id
        {
            get; init;
        }

        public int ArticleId
        {
            get; init;
        }

        public long? ParentId
        {
            get; init;
        }

        public long? RootId
        {
            get; init;
        }
    }

    private sealed class IntegrityUserRow
    {
        public int Id
        {
            get; init;
        }

        public int Status
        {
            get; init;
        }

        public DateTime? DeletedAt
        {
            get; init;
        }
    }

    private sealed class IntegritySessionRow
    {
        public string SessionId { get; init; } = string.Empty;

        public int UserId
        {
            get; init;
        }

        public DateTime? RevokedAt
        {
            get; init;
        }
    }

    private sealed class IntegrityAssetRow
    {
        public string Id { get; init; } = string.Empty;

        public string Url { get; init; } = string.Empty;
    }
}
