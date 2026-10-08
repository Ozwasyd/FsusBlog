using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.NotificationStream;

using SqlSugar;

namespace FsusBlog.Server.Services;

public static class ArticleCommentModerationModes
{
    public const string Direct = "direct";
    public const string Premoderated = "premoderated";
    public const string RiskBased = "risk_based";

    public static bool IsValid(string? value) => value is Direct or Premoderated or RiskBased;
}

public sealed record EffectiveArticleCommentPolicy(
    int ArticleId,
    bool Enabled,
    bool PublicCommentsEnabled,
    bool AnonymousCommentsEnabled,
    string ModerationMode,
    int SlowModeSeconds,
    DateTime? ClosedAtUtc,
    long ArticlePolicyVersion,
    long? RootCommentId,
    bool ThreadLocked,
    long ThreadPolicyVersion,
    string SnapshotHash)
{
    public bool IsOpen(DateTime utcNow) => Enabled && (!ClosedAtUtc.HasValue || ClosedAtUtc.Value > utcNow);
}

public sealed record ArticleCommentPolicyUpdateRequest(
    bool? Enabled,
    bool? PublicCommentsEnabled,
    bool? AnonymousCommentsEnabled,
    string? ModerationMode,
    int? SlowModeSeconds,
    DateTime? ClosedAtUtc,
    long ExpectedPolicyVersion,
    string? Reason);

public sealed record ThreadCommentPolicyUpdateRequest(bool Locked, long ExpectedPolicyVersion, string? Reason);

public sealed record CommentPolicyWriteDecision(bool Allowed, string Status, EffectiveArticleCommentPolicy Policy)
{
    public static CommentPolicyWriteDecision Allow(EffectiveArticleCommentPolicy policy) => new(true, "allowed", policy);
    public static CommentPolicyWriteDecision Reject(string status, EffectiveArticleCommentPolicy policy) => new(false, status, policy);
}

public interface IArticleCommentPolicyService
{
    Task<EffectiveArticleCommentPolicy> ResolveAsync(int articleId, long? rootCommentId = null, CancellationToken cancellationToken = default);
    Task<CommentPolicyWriteDecision> ValidateWriteAsync(int articleId, long? rootCommentId, string authorMode, string? privacySafeSubjectHash, bool consumeSlowMode, CancellationToken cancellationToken = default);
    Task<EffectiveArticleCommentPolicy> UpdateArticleAsync(int articleId, ArticleCommentPolicyUpdateRequest request, long adminPrincipalId, CancellationToken cancellationToken = default);
    Task<EffectiveArticleCommentPolicy> UpdateThreadAsync(int articleId, long rootCommentId, ThreadCommentPolicyUpdateRequest request, long adminPrincipalId, CancellationToken cancellationToken = default);
}

public sealed class ArticleCommentPolicyService(
    ISqlSugarClient db,
    IAnonymousCommentPolicyService sitePolicy,
    ICacheInvalidationDispatcher cacheInvalidation,
    INotificationStreamPublisher notificationStreamPublisher) : IArticleCommentPolicyService
{
    public async Task<EffectiveArticleCommentPolicy> ResolveAsync(
        int articleId,
        long? rootCommentId = null,
        CancellationToken cancellationToken = default)
    {
        AnonymousCommentPolicySnapshot site = await sitePolicy.GetCurrentAsync(cancellationToken);
        ArticleCommentPolicy? article = await db.Queryable<ArticleCommentPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(cancellationToken);
        CommentThreadPolicy? thread = rootCommentId.HasValue
            ? await db.Queryable<CommentThreadPolicy>()
                .Where(item => item.ArticleId == articleId && item.RootCommentId == rootCommentId.Value)
                .FirstAsync(cancellationToken)
            : null;
        return Compose(articleId, site, article, thread);
    }

    public async Task<CommentPolicyWriteDecision> ValidateWriteAsync(
        int articleId,
        long? rootCommentId,
        string authorMode,
        string? privacySafeSubjectHash,
        bool consumeSlowMode,
        CancellationToken cancellationToken = default)
    {
        EffectiveArticleCommentPolicy policy = await ResolveAsync(articleId, rootCommentId, cancellationToken);
        CommentPolicyWriteDecision policyDecision = EvaluateWrite(policy, authorMode, DateTime.UtcNow);
        if (!policyDecision.Allowed)
            return policyDecision;
        if (!consumeSlowMode || policy.SlowModeSeconds <= 0)
        {
            return CommentPolicyWriteDecision.Allow(policy);
        }
        if (string.IsNullOrWhiteSpace(privacySafeSubjectHash) || privacySafeSubjectHash.Length > 64)
        {
            return CommentPolicyWriteDecision.Reject("comment_slow_mode_subject_unavailable", policy);
        }

        DateTime now = DateTime.UtcNow;
        int affected = await db.Ado.ExecuteCommandAsync("""
            INSERT INTO comment_slow_mode_state(article_id, subject_hash, next_allowed_at_utc)
            VALUES (@ArticleId, @SubjectHash, @NextAllowedAtUtc)
            ON CONFLICT (article_id, subject_hash) DO UPDATE
            SET next_allowed_at_utc = EXCLUDED.next_allowed_at_utc
            WHERE comment_slow_mode_state.next_allowed_at_utc <= @NowUtc;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@SubjectHash", privacySafeSubjectHash),
            new SugarParameter("@NextAllowedAtUtc", now.AddSeconds(policy.SlowModeSeconds)),
            new SugarParameter("@NowUtc", now));
        return affected > 0
            ? CommentPolicyWriteDecision.Allow(policy)
            : CommentPolicyWriteDecision.Reject("comment_slow_mode_active", policy);
    }

    public async Task<EffectiveArticleCommentPolicy> UpdateArticleAsync(
        int articleId,
        ArticleCommentPolicyUpdateRequest request,
        long adminPrincipalId,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtext('article_comment_policy'), @ArticleId);",
                new SugarParameter("@ArticleId", articleId));
            ArticleCommentPolicy? current = await db.Queryable<ArticleCommentPolicy>()
                .Where(item => item.ArticleId == articleId)
                .FirstAsync(cancellationToken);
            long currentVersion = current?.PolicyVersion ?? 0;
            if (currentVersion != request.ExpectedPolicyVersion)
            {
                throw new InvalidOperationException("comment_policy_version_conflict");
            }
            var next = new ArticleCommentPolicy
            {
                ArticleId = articleId,
                Enabled = request.Enabled,
                PublicCommentsEnabled = request.PublicCommentsEnabled,
                AnonymousCommentsEnabled = request.AnonymousCommentsEnabled,
                ModerationMode = request.ModerationMode,
                SlowModeSeconds = request.SlowModeSeconds,
                ClosedAtUtc = request.ClosedAtUtc,
                UpdatedByAdminPrincipalId = adminPrincipalId,
                PolicyVersion = currentVersion + 1,
                UpdatedAtUtc = DateTime.UtcNow
            };
            if (current is null)
            {
                await db.Insertable(next).ExecuteCommandAsync(cancellationToken);
            }
            else
            {
                await db.Updateable(next).ExecuteCommandAsync(cancellationToken);
            }
            await AppendAuditAsync(next.ArticleId, null, next.PolicyVersion, "article_policy_updated", request.Reason, adminPrincipalId, cancellationToken);
        });
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException ?? new InvalidOperationException("comment_policy_update_failed");
        }
        await cacheInvalidation.InvalidateCommentPolicyAsync(cancellationToken);
        await PublishPolicyChangedAsync(articleId, null, cancellationToken);
        return await ResolveAsync(articleId, cancellationToken: cancellationToken);
    }

    public async Task<EffectiveArticleCommentPolicy> UpdateThreadAsync(
        int articleId,
        long rootCommentId,
        ThreadCommentPolicyUpdateRequest request,
        long adminPrincipalId,
        CancellationToken cancellationToken = default)
    {
        if (articleId <= 0 || rootCommentId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(rootCommentId));
        }
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtext('comment_thread_policy'), hashint8(@RootCommentId));",
                new SugarParameter("@RootCommentId", rootCommentId));
            bool rootExists = await db.Queryable<Comment>()
                .Where(item => item.Id == rootCommentId && item.ArticleId == articleId && item.ParentId == null)
                .AnyAsync();
            if (!rootExists)
            {
                throw new InvalidOperationException("comment_thread_not_found");
            }
            CommentThreadPolicy? current = await db.Queryable<CommentThreadPolicy>()
                .Where(item => item.RootCommentId == rootCommentId && item.ArticleId == articleId)
                .FirstAsync(cancellationToken);
            long currentVersion = current?.PolicyVersion ?? 0;
            if (currentVersion != request.ExpectedPolicyVersion)
            {
                throw new InvalidOperationException("comment_policy_version_conflict");
            }
            var next = new CommentThreadPolicy
            {
                RootCommentId = rootCommentId,
                ArticleId = articleId,
                LockedAtUtc = request.Locked ? DateTime.UtcNow : null,
                LockedByAdminPrincipalId = request.Locked ? adminPrincipalId : null,
                LockReason = request.Locked ? NormalizeReason(request.Reason) : null,
                PolicyVersion = currentVersion + 1
            };
            if (current is null)
            {
                await db.Insertable(next).ExecuteCommandAsync(cancellationToken);
            }
            else
            {
                await db.Updateable(next).ExecuteCommandAsync(cancellationToken);
            }
            await AppendAuditAsync(articleId, rootCommentId, next.PolicyVersion, request.Locked ? "thread_locked" : "thread_unlocked", request.Reason, adminPrincipalId, cancellationToken);
        });
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException ?? new InvalidOperationException("comment_thread_policy_update_failed");
        }
        await cacheInvalidation.InvalidateCommentPolicyAsync(cancellationToken);
        await PublishPolicyChangedAsync(articleId, rootCommentId, cancellationToken);
        return await ResolveAsync(articleId, rootCommentId, cancellationToken);
    }

    public static EffectiveArticleCommentPolicy Compose(
        int articleId,
        AnonymousCommentPolicySnapshot site,
        ArticleCommentPolicy? article,
        CommentThreadPolicy? thread)
    {
        bool enabled = article?.Enabled ?? true;
        bool publicEnabled = site.PublicCommentsEnabled && (article?.PublicCommentsEnabled ?? true);
        bool anonymousEnabled = site.AnonymousCommentsEnabled && (article?.AnonymousCommentsEnabled ?? true);
        string moderationMode = ArticleCommentModerationModes.IsValid(article?.ModerationMode)
            ? article!.ModerationMode!
            : ArticleCommentModerationModes.RiskBased;
        int slowMode = Math.Clamp(article?.SlowModeSeconds ?? 0, 0, 86_400);
        long articleVersion = article?.PolicyVersion ?? 0;
        long threadVersion = thread?.PolicyVersion ?? 0;
        string material = string.Join('|', site.SnapshotHash, articleId, enabled, publicEnabled, anonymousEnabled,
            moderationMode, slowMode, article?.ClosedAtUtc?.Ticks ?? 0, articleVersion,
            thread?.RootCommentId ?? 0, thread?.LockedAtUtc?.Ticks ?? 0, threadVersion);
        string hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
        return new EffectiveArticleCommentPolicy(articleId, enabled, publicEnabled, anonymousEnabled,
            moderationMode, slowMode, article?.ClosedAtUtc, articleVersion, thread?.RootCommentId,
            thread?.LockedAtUtc.HasValue == true, threadVersion, hash);
    }

    public static CommentPolicyWriteDecision EvaluateWrite(
        EffectiveArticleCommentPolicy policy,
        string authorMode,
        DateTime utcNow)
    {
        if (!policy.IsOpen(utcNow))
            return CommentPolicyWriteDecision.Reject("comment_policy_closed", policy);
        if (policy.RootCommentId.HasValue && policy.ThreadLocked)
            return CommentPolicyWriteDecision.Reject("comment_thread_locked", policy);
        if (string.Equals(authorMode, CommentAuthorModes.Public, StringComparison.Ordinal) && !policy.PublicCommentsEnabled)
            return CommentPolicyWriteDecision.Reject("public_comments_disabled", policy);
        if (!string.Equals(authorMode, CommentAuthorModes.Public, StringComparison.Ordinal) && !policy.AnonymousCommentsEnabled)
            return CommentPolicyWriteDecision.Reject("anonymous_comments_disabled", policy);
        return CommentPolicyWriteDecision.Allow(policy);
    }

    private Task AppendAuditAsync(int articleId, long? rootCommentId, long version, string action, string? reason, long adminPrincipalId, CancellationToken cancellationToken)
        => db.Insertable(new CommentPolicyAuditEvent
        {
            ArticleId = articleId,
            RootCommentId = rootCommentId,
            PolicyVersion = version,
            Action = action,
            Reason = NormalizeReason(reason),
            AdminPrincipalId = adminPrincipalId,
            OccurredAtUtc = DateTime.UtcNow
        }).ExecuteCommandAsync(cancellationToken);

    private async Task PublishPolicyChangedAsync(int articleId, long? rootCommentId, CancellationToken cancellationToken)
    {
        string scope = rootCommentId.HasValue
            ? $"article:{articleId}:thread:{rootCommentId.Value}"
            : $"article:{articleId}";
        await notificationStreamPublisher.PublishAsync(
            NotificationStreamEventType.CacheControl,
            new CacheControlPayload("comment-policy.updated", scope, "comment-policy"),
            new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed),
            cancellationToken,
            $"comment-policy:{scope}:{DateTime.UtcNow.Ticks}");
    }

    private static void ValidateRequest(ArticleCommentPolicyUpdateRequest request)
    {
        if (request.ExpectedPolicyVersion < 0)
            throw new ArgumentOutOfRangeException(nameof(request.ExpectedPolicyVersion));
        if (request.ModerationMode is not null && !ArticleCommentModerationModes.IsValid(request.ModerationMode))
            throw new ArgumentException("comment_moderation_mode_invalid", nameof(request.ModerationMode));
        if (request.SlowModeSeconds is < 0 or > 86_400)
            throw new ArgumentOutOfRangeException(nameof(request.SlowModeSeconds));
    }

    private static string? NormalizeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason) ? null : reason.Trim()[..Math.Min(reason.Trim().Length, 256)];
}
