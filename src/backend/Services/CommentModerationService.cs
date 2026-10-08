using System.Data.Common;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Services;

public readonly record struct CommentModerationActorContext(
    int? UserId,
    string AuthorMode,
    string DisplayLanguage,
    string? ModerationSubjectHash,
    string? AnonymousNullifierHash,
    string? AnonymousScope,
    string RateClass,
    bool RequiresModeration);

public readonly record struct CommentInitialModerationDecision(
    CommentModerationStatus Status,
    string ReasonCode);

public interface ICommentModerationService
{
    RegionModerationDecision ResolveSubmissionRegion(
        string content,
        int articleId,
        int userId,
        RegionModerationDecision? suppliedDecision);

    CommentInitialModerationDecision ResolveInitialState(
        CommentActor actor,
        RegionModerationDecision regionDecision);

    Task PersistVisibilityAsync(
        long commentId,
        RegionModerationDecision decision,
        CancellationToken cancellationToken);

    Task ApplyPostInsertAsync(
        Comment comment,
        CommentModerationActorContext actor,
        RegionModerationDecision regionDecision,
        CancellationToken cancellationToken);
}

public sealed class CommentModerationService(
    ISqlSugarClient db,
    IRegionLegalModerationService regions,
    ICacheInvalidationDispatcher invalidations,
    ICommentNotificationService notifications,
    ILogger<CommentModerationService> logger,
    IAntiSpamModerationService? antiSpam = null,
    ICommentModerationDispositionPolicy? dispositionPolicy = null,
    AuditLogChannel? audit = null,
    IAnonymousCommentPolicyService? anonymousPolicy = null,
    IConfiguration? configuration = null,
    ICommentMutationOutbox? mutationOutbox = null,
    TimeProvider? timeProvider = null) : ICommentModerationService
{
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;
    public RegionModerationDecision ResolveSubmissionRegion(
        string content,
        int articleId,
        int userId,
        RegionModerationDecision? suppliedDecision)
        => suppliedDecision ?? regions.EvaluateOnSubmit(new RegionModerationRequest(
            content,
            articleId,
            userId,
            RegionCodes.Unknown,
            0d,
            "fallback",
            null,
            null,
            _clock.GetUtcNow().UtcDateTime));

    public CommentInitialModerationDecision ResolveInitialState(
        CommentActor actor,
        RegionModerationDecision regionDecision)
    {
        if (regionDecision.HideUntilReviewed || regionDecision.RequiresManualReview || actor.RequiresModeration)
        {
            return ResolveInitialState(actor, regionDecision, modelEnabled: false, modelProviderAvailable: false);
        }

        return ResolveInitialState(
            actor,
            regionDecision,
            configuration?.GetValue<bool?>("Moderation:AntiSpamModel:Enabled") ?? antiSpam is not null,
            antiSpam is not null);
    }

    public static CommentInitialModerationDecision ResolveInitialState(
        CommentActor actor,
        RegionModerationDecision regionDecision,
        bool modelEnabled,
        bool modelProviderAvailable)
    {
        if (regionDecision.HideUntilReviewed)
        {
            return new(CommentModerationStatus.Hidden, "hidden_region_review");
        }

        if (regionDecision.RequiresManualReview)
        {
            return new(CommentModerationStatus.Pending, "pending_region_review");
        }

        if (actor.RequiresModeration)
        {
            return new(CommentModerationStatus.Pending, "pending_anonymous_policy");
        }

        if (modelEnabled)
        {
            return new(
                CommentModerationStatus.Pending,
                modelProviderAvailable ? "pending_model_review" : "pending_model_provider_unavailable");
        }

        return new(CommentModerationStatus.Approved, "approved_deterministic_low_risk");
    }

    public async Task PersistVisibilityAsync(
        long commentId,
        RegionModerationDecision decision,
        CancellationToken cancellationToken)
    {
        await db.Insertable(BuildRegionCompliance(commentId, decision, _clock.GetUtcNow().UtcDateTime)).ExecuteCommandAsync(cancellationToken);
        await ReplaceBlockedRegionsAsync(commentId, decision.BlockedRegions, cancellationToken);
    }

    public async Task ApplyPostInsertAsync(
        Comment comment,
        CommentModerationActorContext actor,
        RegionModerationDecision regionDecision,
        CancellationToken cancellationToken)
    {
        if (antiSpam is null)
        {
            return;
        }

        AnonymousCommentPolicySnapshot? policySnapshot = anonymousPolicy is null
            ? null
            : await anonymousPolicy.GetCurrentAsync(cancellationToken);
        AntiSpamModerationResult? modelResult = await antiSpam.ScoreCommentAsync(
            new AntiSpamCommentModerationContext(
                comment.Id,
                comment.ArticleId,
                actor.UserId,
                actor.AuthorMode,
                actor.DisplayLanguage,
                actor.ModerationSubjectHash,
                actor.AnonymousNullifierHash,
                actor.AnonymousScope,
                actor.RateClass,
                actor.RequiresModeration,
                policySnapshot?.AnonymousCommentsEnabled,
                policySnapshot?.ZkAnonymousEnabled,
                comment.Content,
                comment.ParentId,
                regionDecision.SubmitIpHash,
                regionDecision.SubmitRegion,
                regionDecision.PolicyVersion,
                comment.CreateTime),
            cancellationToken);
        if (modelResult is null || dispositionPolicy is null)
        {
            return;
        }

        CommentModerationDisposition disposition = dispositionPolicy.Decide(comment, regionDecision, modelResult);
        await ApplyAutomaticDispositionAsync(comment, disposition, cancellationToken);
    }

    private async Task ApplyAutomaticDispositionAsync(
        Comment comment,
        CommentModerationDisposition disposition,
        CancellationToken cancellationToken)
    {
        if (!disposition.AutoApplied
            || !CommentModerationTransitions.IsAllowed(comment.ModerationStatus, disposition.NextStatus))
        {
            return;
        }

        CommentModerationStatus previousStatus = comment.ModerationStatus;
        DateTime moderatedAt = _clock.GetUtcNow().UtcDateTime;
        string reason = TextHelpers.NormalizeNullable($"model_policy:{disposition.Reason}", 256)
            ?? disposition.Reason;
        AutomaticModerationTarget? target = await LoadTargetAsync(comment.Id, cancellationToken);
        if (target is null
            || target.ModerationStatus != previousStatus
            || !CommentModerationTransitions.IsAllowed(target.ModerationStatus, disposition.NextStatus))
        {
            logger.LogInformation(
                "模型审核自动处置未应用，评论状态已变化 | CommentId: {CommentId} | Previous: {PreviousStatus} | Current: {CurrentStatus} | Next: {NextStatus}",
                comment.Id,
                previousStatus,
                target?.ModerationStatus,
                disposition.NextStatus);
            return;
        }

        bool applied = await TryApplyDispositionAsync(comment, target, disposition.NextStatus, reason, moderatedAt, cancellationToken);
        if (!applied)
        {
            AutomaticModerationTarget? latest = await LoadTargetAsync(comment.Id, cancellationToken);
            if (latest is null || latest.ModerationStatus != previousStatus)
            {
                logger.LogInformation(
                    "模型审核自动处置未应用，评论状态已变化 | CommentId: {CommentId} | Previous: {PreviousStatus} | Current: {CurrentStatus} | Next: {NextStatus}",
                    comment.Id,
                    previousStatus,
                    latest?.ModerationStatus,
                    disposition.NextStatus);
                return;
            }

            applied = await TryApplyDispositionAsync(comment, latest, disposition.NextStatus, reason, moderatedAt, cancellationToken);
            if (!applied)
            {
                logger.LogWarning(
                    "模型审核自动处置重试仍未应用，保留评论在人工审核队列 | CommentId: {CommentId} | Previous: {PreviousStatus} | Next: {NextStatus}",
                    comment.Id,
                    previousStatus,
                    disposition.NextStatus);
                return;
            }
        }

        comment.ModerationStatus = disposition.NextStatus;
        comment.ModerationReason = reason;
        comment.ModeratedByAdminPrincipalId = null;
        comment.ModeratedAt = moderatedAt;
        if (mutationOutbox is not null)
        {
            return;
        }

        WriteAudit(comment, disposition);
        if (previousStatus != CommentModerationStatus.Approved
            && disposition.NextStatus == CommentModerationStatus.Approved)
        {
            await invalidations.InvalidateCommentMutationAsync(
                new CommentCacheInvalidationScope(
                    ArticleId: comment.ArticleId,
                    RootId: comment.RootId ?? comment.Id,
                    AccountId: comment.UserId,
                    PublicArticleChanged: true,
                    UserCommentsChanged: comment.UserId is > 0),
                cancellationToken);
            await notifications.PublishAddedAsync(comment, moderatedAt);
        }
        else if (previousStatus == CommentModerationStatus.Approved
            && disposition.NextStatus is CommentModerationStatus.Hidden or CommentModerationStatus.Rejected)
        {
            await invalidations.InvalidateCommentMutationAsync(
                new CommentCacheInvalidationScope(
                    ArticleId: comment.ArticleId,
                    RootId: comment.RootId ?? comment.Id,
                    AccountId: comment.UserId,
                    PublicArticleChanged: true,
                    UserCommentsChanged: comment.UserId is > 0),
                cancellationToken);
            await notifications.PublishRemovedAsync(
                comment.ArticleId,
                comment.Id,
                comment.RootId ?? comment.Id,
                comment.ParentId);
            _ = notifications.NotifyModelRiskHiddenAsync(comment, disposition);
        }
    }

    private async Task<AutomaticModerationTarget?> LoadTargetAsync(
        long commentId,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   moderation_status,
                   xmin::text AS row_version
            FROM comment
            WHERE id = @CommentId
              AND is_deleted = false;
            """,
            new SugarParameter("@CommentId", commentId));
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new AutomaticModerationTarget(
            reader.ReadInt64("id"),
            (CommentModerationStatus)reader.ReadInt32("moderation_status"),
            reader.ReadString("row_version"));
    }

    private async Task<bool> TryApplyDispositionAsync(
        Comment comment,
        AutomaticModerationTarget target,
        CommentModerationStatus nextStatus,
        string reason,
        DateTime moderatedAt,
        CancellationToken cancellationToken)
    {
        int affected = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            affected = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE comment
                SET moderation_status = @NextStatus,
                    moderation_reason = @Reason,
                    moderated_by_admin_principal_id = NULL,
                    moderated_at = CAST(@ModeratedAt AS timestamp)
                WHERE id = @CommentId
                  AND is_deleted = false
                  AND moderation_status = @ExpectedStatus
                  AND xmin::text = @RowVersion;
                """,
                new SugarParameter("@CommentId", target.Id),
                new SugarParameter("@ExpectedStatus", (int)target.ModerationStatus),
                new SugarParameter("@NextStatus", (int)nextStatus),
                new SugarParameter("@Reason", reason),
                new SugarParameter("@ModeratedAt", moderatedAt),
                new SugarParameter("@RowVersion", target.RowVersion));
            if (affected <= 0)
            {
                return;
            }

            await db.Insertable(new CommentModerationEvent
            {
                CommentId = comment.Id,
                EventType = nextStatus switch
                {
                    CommentModerationStatus.Approved => CommentModerationEventTypes.Approve,
                    CommentModerationStatus.Rejected => CommentModerationEventTypes.Reject,
                    CommentModerationStatus.Hidden => CommentModerationEventTypes.Hide,
                    _ => CommentModerationEventTypes.Pending
                },
                PreviousStatus = target.ModerationStatus,
                NextStatus = nextStatus,
                ActorType = "system",
                ReasonCode = reason,
                TransitionSource = "model",
                OccurredAtUtc = moderatedAt
            }).ExecuteCommandAsync(cancellationToken);
            if (mutationOutbox is null)
            {
                return;
            }

            await mutationOutbox.EnqueueAsync(new CommentMutationOutboxEvent
            {
                EventType = CommentMutationEventTypes.ModerationChanged,
                CommentId = comment.Id,
                ArticleId = comment.ArticleId,
                RootId = comment.RootId ?? comment.Id,
                ParentId = comment.ParentId,
                AccountId = comment.UserId,
                ReplyToAccountId = comment.ReplyToUserId,
                PreviousStatus = target.ModerationStatus,
                NextStatus = nextStatus,
                OccurredAtUtc = moderatedAt
            }, cancellationToken);
            if (nextStatus == CommentModerationStatus.Approved && comment.ReplyToUserId is > 0)
            {
                await mutationOutbox.EnqueueAsync(new CommentMutationOutboxEvent
                {
                    EventType = CommentMutationEventTypes.ReplyNotificationRequested,
                    CommentId = comment.Id,
                    ArticleId = comment.ArticleId,
                    RootId = comment.RootId ?? comment.Id,
                    ParentId = comment.ParentId,
                    AccountId = comment.UserId,
                    ReplyToAccountId = comment.ReplyToUserId,
                    PreviousStatus = target.ModerationStatus,
                    NextStatus = nextStatus,
                    OccurredAtUtc = moderatedAt
                }, cancellationToken);
            }
        });
        return transaction.IsSuccess && affected > 0;
    }

    private static CommentRegionCompliance BuildRegionCompliance(
        long commentId,
        RegionModerationDecision decision,
        DateTime now)
    {
        return new CommentRegionCompliance
        {
            CommentId = commentId,
            SubmitRegion = TextHelpers.NormalizeNullable(decision.SubmitRegion, 64) ?? RegionCodes.Unknown,
            SubmitRegionConfidence = Math.Clamp(decision.SubmitRegionConfidence, 0d, 1d),
            RegionProvider = TextHelpers.NormalizeNullable(decision.RegionProvider, 64) ?? "unknown",
            SubmitIpHash = TextHelpers.NormalizeNullable(decision.SubmitIpHash, 64),
            PolicyVersion = TextHelpers.NormalizeNullable(decision.PolicyVersion, 64)
                ?? RegionLegalModerationService.CurrentPolicyVersion,
            CanPublish = decision.CanPublish,
            RequiresManualReview = decision.RequiresManualReview,
            HideUntilReviewed = decision.HideUntilReviewed,
            BlockedRegions = RegionLegalModerationService.SerializeRegions(decision.BlockedRegions),
            RiskLabels = string.Join(',', decision.RiskLabels
                .Where(static label => !string.IsNullOrWhiteSpace(label))
                .Select(static label => label.Trim())
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static label => label, StringComparer.Ordinal)),
            DecisionReason = TextHelpers.NormalizeNullable(decision.DecisionReason, 256),
            RuleHitsJson = decision.RuleHits.Count == 0 ? null : JsonSerializer.Serialize(decision.RuleHits),
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };
    }

    private async Task ReplaceBlockedRegionsAsync(
        long commentId,
        IReadOnlyCollection<string> blockedRegions,
        CancellationToken cancellationToken)
    {
        await db.Deleteable<CommentBlockedRegion>()
            .Where(row => row.CommentId == commentId)
            .ExecuteCommandAsync(cancellationToken);
        CommentBlockedRegion[] rows = [.. blockedRegions
            .Where(static region => !string.IsNullOrWhiteSpace(region))
            .Select(static region => region.Trim().ToUpperInvariant())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static region => region, StringComparer.Ordinal)
            .Select(region => new CommentBlockedRegion
            {
                CommentId = commentId,
                RegionCode = TextHelpers.NormalizeNullable(region, 64) ?? RegionCodes.Unknown
            })];
        if (rows.Length > 0)
        {
            await db.Insertable(rows).ExecuteCommandAsync(cancellationToken);
        }
    }

    private void WriteAudit(Comment comment, CommentModerationDisposition disposition)
    {
        if (audit is null)
        {
            return;
        }

        string context = JsonSerializer.Serialize(disposition.AuditContext);
        audit.TryWrite(new AuditRecord(
            AuditSourceCatalog.Comment,
            AuditTypeCatalog.Business,
            _clock.GetUtcNow().UtcDateTime,
            "model_moderation_auto_disposition",
            Encoding.UTF8.GetBytes(context),
            Action: "model_moderation_auto_disposition",
            Outcome: AuditOutcomeCatalog.Success,
            Severity: disposition.NextStatus == CommentModerationStatus.Hidden
                ? AuditSeverityCatalog.Warning
                : AuditSeverityCatalog.Info,
            ActorType: AuditActorTypeCatalog.System,
            TargetType: "comment",
            TargetId: comment.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ReasonCode: disposition.Reason,
            ContextJson: context));
    }

    private sealed record AutomaticModerationTarget(
        long Id,
        CommentModerationStatus ModerationStatus,
        string RowVersion);
}
