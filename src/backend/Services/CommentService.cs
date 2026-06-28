using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class CommentService(
    ISqlSugarClient db,
    ILogger<CommentService> logger,
    IMessageRealtimePublisher messageService,
    IMessageCommandService messageCommandService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IRegionLegalModerationService regionLegalModerationService,
    IAntiSpamModerationService? antiSpamModerationService = null,
    ICommentActorResolver? commentActorResolver = null,
    IAnonymousCommentPolicyService? anonymousCommentPolicyService = null,
    ICommentAnonymousNullifierService? anonymousNullifierService = null,
    ICommentModerationDispositionPolicy? commentModerationDispositionPolicy = null,
    AuditLogChannel? auditLogChannel = null,
    ISecurityRiskSignalSink? securityRiskSignalSink = null,
    IHttpContextAccessor? httpContextAccessor = null,
    IAnonymousCommentTicketService? anonymousCommentTicketService = null,
    ICommentAnonymousDisplayNameGenerator? anonymousDisplayNameGenerator = null,
    IConfiguration? configuration = null) : ICommentService, ICommentEndpointService
{
    private const int DefaultReplyPreviewLimit = 3;
    private const int MaxReplyPreviewRootIds = 50;
    private const string DeletedPlaceholder = "该回复已删除";
    private static readonly Int64CursorCodec CursorCodec = Int64CursorCodec.Instance;

    private static bool TryParsePositiveCommentId(string? raw, out long value)
    {
        value = 0;
        return !string.IsNullOrWhiteSpace(raw)
            && long.TryParse(raw, out value)
            && value > 0;
    }

    public async Task<bool> CreateCommentAsync(int userId, CommentDto dto)
    {
        if (dto.ArticleId <= 0)
        {
            return false;
        }

        string normalizedContent = NormalizeCommentContent(dto.Content);
        if (!IsCommentContentWithinLimit(normalizedContent))
        {
            return false;
        }

        RegionModerationDecision regionDecision = dto.RegionDecision ?? regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
            normalizedContent,
            dto.ArticleId,
            userId,
            RegionCodes.Unknown,
            0d,
            "fallback",
            null,
            null,
            DateTime.UtcNow));
        if (!regionDecision.CanPublish)
        {
            return false;
        }

        if (commentActorResolver is null)
        {
            return false;
        }

        CommentActorResolveResult actorResult = await commentActorResolver.ResolveAsync(
            new CommentActorResolveRequest(
                UserId: userId > 0 ? userId : null,
                ArticleId: dto.ArticleId,
                AuthorMode: dto.AuthorMode,
                PublicSendExplicitlySelected: dto.PublicSendExplicitlySelected,
                AnonymousScope: dto.AnonymousScope,
                DisplayLanguage: dto.DisplayLanguage,
                ProofToken: dto.ProofToken,
                ZkProof: dto.ZkProof,
                SubmitRegion: regionDecision.SubmitRegion),
            CancellationToken.None);
        if (!actorResult.Allowed || actorResult.Actor is null)
        {
            return false;
        }

        CommentActor actor = actorResult.Actor;
        return await CreateResolvedCommentAsync(
            dto.ArticleId,
            normalizedContent,
            dto.ParentId,
            dto.RootId,
            dto.ReplyToCommentId,
            actor,
            regionDecision,
            CancellationToken.None);
    }

    public async Task<bool> CreateStrongAnonymousCommentAsync(
        AnonymousCommentCreateRequestCoreModel request,
        RegionModerationDecision? regionDecision = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.ArticleId <= 0)
        {
            return false;
        }

        string normalizedContent = NormalizeCommentContent(request.Content);
        if (!IsCommentContentWithinLimit(normalizedContent))
        {
            return false;
        }

        if (anonymousCommentTicketService is null)
        {
            logger.LogWarning("匿名评论 ticket service 未注册，拒绝匿名评论写入 | Article: {ArticleId}", request.ArticleId);
            return false;
        }

        CacheReadResult<AnonymousCommentTicketPayload> consumed = await anonymousCommentTicketService.ConsumeTicketAsync(
            request.Ticket,
            cancellationToken);
        if (!consumed.Hit || consumed.Value is null)
        {
            return false;
        }

        AnonymousCommentTicketPayload ticket = consumed.Value;
        if (!AnonymousTicketMatchesRequest(ticket, request))
        {
            logger.LogInformation(
                "匿名评论 ticket 绑定校验失败 | Article: {ArticleId} | ScopeHash: {ScopeHash}",
                request.ArticleId,
                HashAnonymousScopeForLog(NormalizeAnonymousScope(request.AnonymousScope, request.ArticleId)));
            return false;
        }

        RegionModerationDecision effectiveRegionDecision = regionDecision ?? regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
            normalizedContent,
            request.ArticleId,
            0,
            RegionCodes.Unknown,
            0d,
            "fallback",
            null,
            null,
            DateTime.UtcNow));
        if (!effectiveRegionDecision.CanPublish)
        {
            return false;
        }

        CommentActor actor = BuildAnonymousTicketActor(ticket, request.DisplayLanguage, effectiveRegionDecision.SubmitRegion);
        return await CreateResolvedCommentAsync(
            request.ArticleId,
            normalizedContent,
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            actor,
            effectiveRegionDecision,
            cancellationToken);
    }

    private async Task<bool> CreateResolvedCommentAsync(
        int articleId,
        string normalizedContent,
        string? requestedParentId,
        string? requestedRootIdRaw,
        string? requestedReplyToCommentIdRaw,
        CommentActor actor,
        RegionModerationDecision regionDecision,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime now = DateTime.UtcNow;
        bool articleExists = await db.Queryable<Article>()
            .Where(a => a.Id == articleId
                && !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .AnyAsync();
        if (!articleExists)
        {
            return false;
        }

        if (!regionDecision.CanPublish)
        {
            return false;
        }

        bool enforceAnonymousNullifier = RequiresAnonymousNullifierEnforcement(actor);
        if (enforceAnonymousNullifier && anonymousNullifierService is null)
        {
            logger.LogWarning(
                "匿名评论 nullifier enforcement 未注册，拒绝评论写入 | Article: {ArticleId} | ScopeHash: {ScopeHash}",
                articleId,
                HashAnonymousScopeForLog(actor.AnonymousScope));
            return false;
        }

        bool hasReplyContext = !string.IsNullOrWhiteSpace(requestedParentId)
            || !string.IsNullOrWhiteSpace(requestedRootIdRaw)
            || !string.IsNullOrWhiteSpace(requestedReplyToCommentIdRaw);
        long? parentId = null;
        long? rootId = null;
        int? replyToUserId = null;
        long? replyToCommentId = null;
        int depth = 0;

        if (hasReplyContext)
        {
            if (!TryParsePositiveCommentId(requestedParentId, out long parsedParentId))
            {
                return false;
            }

            long? requestedRootId = null;
            if (!string.IsNullOrWhiteSpace(requestedRootIdRaw))
            {
                if (!TryParsePositiveCommentId(requestedRootIdRaw, out long parsedRootId))
                {
                    return false;
                }

                requestedRootId = parsedRootId;
            }

            long? requestedReplyToCommentId = null;
            if (!string.IsNullOrWhiteSpace(requestedReplyToCommentIdRaw))
            {
                if (!TryParsePositiveCommentId(requestedReplyToCommentIdRaw, out long parsedReplyToCommentId))
                {
                    return false;
                }

                requestedReplyToCommentId = parsedReplyToCommentId;
            }

            var parent = await db.Queryable<Comment>()
                .Where(c => c.Id == parsedParentId
                    && c.ArticleId == articleId
                    && c.ModerationStatus == CommentModerationStatus.Approved
                    && !c.IsDeleted)
                .Select(c => new
                {
                    c.Id,
                    c.ArticleId,
                    c.RootId,
                    c.ParentId,
                    c.Depth,
                    c.UserId
                })
                .FirstAsync();

            if (parent is null || parent.ArticleId != articleId)
            {
                return false;
            }

            parentId = parent.Id;
            rootId = parent.RootId ?? parent.Id;
            if (requestedRootId.HasValue && requestedRootId.Value != rootId.Value)
            {
                return false;
            }

            bool rootIsVisible = await db.Queryable<Comment>()
                .Where(c => c.Id == rootId.Value
                    && c.ArticleId == articleId
                    && c.ParentId == null
                    && c.ModerationStatus == CommentModerationStatus.Approved
                    && !c.IsDeleted)
                .AnyAsync();
            if (!rootIsVisible)
            {
                return false;
            }

            replyToUserId = actor.UserId.HasValue ? parent.UserId : null;
            replyToCommentId = parent.Id;
            if (requestedReplyToCommentId.HasValue && requestedReplyToCommentId.Value != replyToCommentId.Value)
            {
                return false;
            }

            depth = Math.Max(1, parent.Depth + 1);
        }

        var comment = new Comment
        {
            ArticleId = articleId,
            Content = normalizedContent,
            UserId = actor.UserId,
            AuthorMode = actor.AuthorMode,
            PublicHandle = actor.PublicHandle,
            AnonymousHandle = actor.AnonymousHandle,
            AnonymousDisplayName = actor.DisplayName,
            AnonymousDisplayLanguage = actor.DisplayLanguage,
            AnonymousNullifierHash = actor.AnonymousNullifierHash,
            AnonymousScope = actor.AnonymousScope,
            ModerationSubjectHash = actor.ModerationSubjectHash,
            CredentialLevel = actor.CredentialLevel,
            ReputationBucket = actor.ReputationBucket,
            AccountAgeBucket = actor.AccountAgeBucket,
            CreateTime = DateTime.UtcNow,
            ParentId = parentId,
            RootId = rootId,
            ReplyToUserId = replyToUserId,
            ReplyToCommentId = replyToCommentId,
            Depth = depth,
            IsDeleted = false,
            DeleteReason = null,
            DeleteTime = null,
            ModerationStatus = CommentModerationStatus.Pending,
            ModerationReason = BuildInitialModerationReason(regionDecision)
        };

        long generatedId = 0;
        var insertResult = await db.Ado.UseTranAsync(async () =>
        {
            if (enforceAnonymousNullifier)
            {
                NullifierReservationResult reservation = await anonymousNullifierService!.CheckAndReserveAsync(
                    actor.AnonymousNullifierHash!,
                    actor.AnonymousScope!,
                    cancellationToken);
                if (!reservation.Allowed)
                {
                    throw new AnonymousNullifierRejectedException(reservation.Status, reservation.Message);
                }
            }

            if (!await LockVisibleCommentTargetAsync(articleId, parentId, rootId, now, cancellationToken))
            {
                throw new CommentTargetNotVisibleException();
            }

            generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
            if (generatedId <= 0)
            {
                throw new InvalidOperationException("Failed to create comment id.");
            }

            await db.Insertable(BuildRegionCompliance(generatedId, regionDecision)).ExecuteCommandAsync();
            await ReplaceBlockedRegionsAsync(generatedId, regionDecision.BlockedRegions, cancellationToken);

            if (enforceAnonymousNullifier)
            {
                bool incremented = await anonymousNullifierService!.IncrementUsageAsync(
                    actor.AnonymousNullifierHash!,
                    actor.AnonymousScope!,
                    generatedId,
                    cancellationToken);
                if (!incremented)
                {
                    throw new AnonymousNullifierRejectedException(
                        "scope_limit_exceeded",
                        "Anonymous nullifier usage could not be incremented.");
                }
            }
        });
        if (!insertResult.IsSuccess || generatedId <= 0)
        {
            if (insertResult.ErrorException is AnonymousNullifierRejectedException rejected)
            {
                logger.LogInformation(
                    "匿名评论 nullifier enforcement 拒绝写入 | Article: {ArticleId} | ScopeHash: {ScopeHash} | Status: {Status}",
                    articleId,
                    HashAnonymousScopeForLog(actor.AnonymousScope),
                    rejected.Status);
                await RecordNullifierAbuseRiskSignalAsync(actor.AnonymousScope, rejected.Status, cancellationToken);
                return false;
            }

            if (insertResult.ErrorException is CommentTargetNotVisibleException)
            {
                return false;
            }

            logger.LogWarning(insertResult.ErrorException, "评论创建或地区合规记录写入失败 | Article: {ArticleId} | User: {UserId}", articleId, actor.UserId);
            return false;
        }

        comment.Id = generatedId;
        if (antiSpamModerationService is not null)
        {
            AnonymousCommentPolicySnapshot? policySnapshot = anonymousCommentPolicyService is null
                ? null
                : await anonymousCommentPolicyService.GetCurrentAsync(cancellationToken);
            AntiSpamModerationResult? modelResult = await antiSpamModerationService.ScoreCommentAsync(
                new AntiSpamCommentModerationContext(
                    comment.Id,
                    comment.ArticleId,
                    actor.UserId,
                    actor.AuthorMode,
                    actor.DisplayLanguage,
                    actor.ModerationSubjectHash,
                    actor.AnonymousNullifierHash,
                    actor.AnonymousScope,
                    actor.CredentialLevel,
                    actor.ReputationBucket,
                    actor.AccountAgeBucket,
                    policySnapshot?.AnonymousCommentsEnabled,
                    policySnapshot?.ZkAnonymousEnabled,
                    comment.Content,
                    comment.ParentId,
                    regionDecision.SubmitIpHash,
                    regionDecision.SubmitRegion,
                    regionDecision.PolicyVersion,
                    comment.CreateTime),
                cancellationToken);
            if (modelResult is not null && commentModerationDispositionPolicy is not null)
            {
                CommentModerationDisposition disposition = commentModerationDispositionPolicy.Decide(comment, regionDecision, modelResult);
                await ApplyAutomaticModerationDispositionAsync(comment, disposition, cancellationToken);
            }
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: comment.ArticleId,
                RootId: comment.RootId ?? comment.Id,
                AccountId: actor.UserId,
                PublicArticleChanged: comment.ModerationStatus == CommentModerationStatus.Approved,
                UserCommentsChanged: actor.UserId is > 0),
            cancellationToken);

        logger.LogInformation("评论已进入审核队列 | Article: {ArticleId} | CommentId: {CommentId} | Root: {RootId} | Parent: {ParentId}",
            articleId,
            comment.Id,
            comment.RootId ?? comment.Id,
            comment.ParentId);

        return true;
    }

    private async Task<bool> LockVisibleCommentTargetAsync(
        int articleId,
        long? parentId,
        long? rootId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!await HasLockedVisibleArticleAsync(articleId, utcNow, cancellationToken))
        {
            return false;
        }

        if (!parentId.HasValue)
        {
            return true;
        }

        if (!rootId.HasValue)
        {
            return false;
        }

        return await HasLockedVisibleCommentAsync(
                parentId.Value,
                articleId,
                rootId.Value,
                requireRoot: false,
                cancellationToken)
            && await HasLockedVisibleCommentAsync(
                rootId.Value,
                articleId,
                rootId.Value,
                requireRoot: true,
                cancellationToken);
    }

    private async Task<bool> HasLockedVisibleArticleAsync(
        int articleId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT 1
            FROM article
            WHERE id = @ArticleId
              AND isdeleted = false
              AND status = @PublishedStatus
              AND (published_at IS NULL OR published_at <= @Now)
              AND (scheduled_publish_at IS NULL OR scheduled_publish_at <= @Now)
            FOR SHARE;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@Now", utcNow));
        return await reader.ReadAsync(cancellationToken);
    }

    private async Task<bool> HasLockedVisibleCommentAsync(
        long commentId,
        int articleId,
        long rootId,
        bool requireRoot,
        CancellationToken cancellationToken)
    {
        string rootPredicate = requireRoot ? "AND parent_id IS NULL" : "AND COALESCE(root_id, id) = @RootId";
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT 1
            FROM comment
            WHERE id = @CommentId
              AND article_id = @ArticleId
              AND moderation_status = @ApprovedStatus
              AND is_deleted = false
              {rootPredicate}
            FOR SHARE;
            """,
            new SugarParameter("@CommentId", commentId),
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RootId", rootId),
            new SugarParameter("@ApprovedStatus", (int)CommentModerationStatus.Approved));
        return await reader.ReadAsync(cancellationToken);
    }

    private static bool RequiresAnonymousNullifierEnforcement(CommentActor actor)
        => !string.IsNullOrWhiteSpace(actor.AnonymousNullifierHash)
            && !string.IsNullOrWhiteSpace(actor.AnonymousScope)
            && (string.Equals(actor.AuthorMode, CommentAuthorModes.Anonymous, StringComparison.Ordinal)
                || string.Equals(actor.AuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal));

    private static string HashAnonymousScopeForLog(string? scope)
    {
        string normalized = string.IsNullOrWhiteSpace(scope) ? "unknown" : scope.Trim();
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..16];
    }

    private CommentActor BuildAnonymousTicketActor(
        AnonymousCommentTicketPayload ticket,
        string? displayLanguage,
        string? submitRegion)
    {
        string language = CommentAnonymousDisplayNameGenerator.NormalizeDisplayLanguage(displayLanguage, submitRegion);
        ICommentAnonymousDisplayNameGenerator generator = anonymousDisplayNameGenerator ?? new CommentAnonymousDisplayNameGenerator();
        CommentAnonymousDisplayName display = generator.Generate(new CommentAnonymousDisplayNameRequest(
            language,
            ticket.Scope,
            ticket.NullifierHash));
        string credentialLevel = NormalizeNullable(ticket.CredentialLevel, 32) ?? AnonymousCredentialLevels.StrongAnonymous;
        string reputationBucket = NormalizeNullable(ticket.ReputationBucket, 32) ?? "unrated";
        return new CommentActor(
            UserId: null,
            AuthorMode: CommentAuthorModes.ZkAnonymous,
            PublicHandle: null,
            AnonymousHandle: $"anon-{ticket.NullifierHash[..Math.Min(ticket.NullifierHash.Length, 12)]}",
            DisplayName: display.DisplayName,
            DisplayLanguage: display.DisplayLanguage,
            AnonymousNullifierHash: ticket.NullifierHash,
            AnonymousScope: ticket.Scope,
            ModerationSubjectHash: Convert.ToHexStringLower(AnonymousCommentTicketService.CreateModerationSubjectHash(
                ticket.NullifierHash,
                configuration ?? throw new InvalidOperationException("Moderation:Pepper must be configured."))),
            CredentialLevel: credentialLevel,
            ReputationBucket: reputationBucket,
            AccountAgeBucket: "credential_bound");
    }

    private static bool AnonymousTicketMatchesRequest(
        AnonymousCommentTicketPayload ticket,
        AnonymousCommentCreateRequestCoreModel request)
    {
        if (!TryParseOptionalPositiveCommentId(request.ParentId, out long? parentId) ||
            !TryParseOptionalPositiveCommentId(request.RootId, out long? rootId) ||
            !TryParseOptionalPositiveCommentId(request.ReplyToCommentId, out long? replyToCommentId))
        {
            return false;
        }

        return ticket.ArticleId == request.ArticleId
            && ticket.CredentialEpoch == request.CredentialEpoch
            && ticket.ExpiresAtUnixMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            && string.Equals(ticket.Scope, NormalizeAnonymousScope(request.AnonymousScope, request.ArticleId), StringComparison.Ordinal)
            && ticket.ParentId == parentId
            && ticket.RootId == rootId
            && ticket.ReplyToCommentId == replyToCommentId;
    }

    private static string NormalizeAnonymousScope(string? value, int articleId)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length == 0 ? $"article:{articleId}" : normalized;
    }

    private static bool TryParseOptionalPositiveCommentId(string? raw, out long? value)
    {
        value = null;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (TryParsePositiveCommentId(raw, out long parsed))
        {
            value = parsed;
            return true;
        }

        return false;
    }

    private static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private async ValueTask RecordNullifierAbuseRiskSignalAsync(
        string? scope,
        string status,
        CancellationToken cancellationToken)
    {
        if (securityRiskSignalSink is null || httpContextAccessor?.HttpContext is not { } httpContext)
        {
            return;
        }

        await securityRiskSignalSink.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.CommentNullifierAbuse,
            25,
            TimeSpan.FromMinutes(30),
            SecurityRiskSources.RiskControl,
            ResolveCommentRiskAction(httpContext),
            $"nullifier:{NormalizeNullable(status, 64) ?? "rejected"};scope:{NormalizeNullable(scope, 64) ?? "unknown"}"), cancellationToken);
    }

    private static string ResolveCommentRiskAction(HttpContext httpContext)
        => httpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] is RiskActionEndpointMetadata metadata
            ? metadata.ActionName
            : RiskActionNames.CommentCreate;

    private static string BuildInitialModerationReason(RegionModerationDecision decision)
    {
        if (decision.DecisionReason.Contains("risk_control_queue", StringComparison.Ordinal))
        {
            return NormalizeNullable(decision.DecisionReason, 256) ?? "risk_control_queue";
        }

        return decision.HideUntilReviewed
            ? "region_policy:manual_review_no_public_display"
            : "pending_review";
    }

    private sealed class AnonymousNullifierRejectedException(string status, string message) : Exception(message)
    {
        public string Status { get; } = status;
    }

    private sealed class CommentTargetNotVisibleException : Exception
    {
    }

    private async Task ApplyAutomaticModerationDispositionAsync(
        Comment comment,
        CommentModerationDisposition disposition,
        CancellationToken cancellationToken)
    {
        if (!disposition.AutoApplied || disposition.NextStatus == comment.ModerationStatus)
        {
            return;
        }

        CommentModerationStatus previousStatus = comment.ModerationStatus;
        DateTime moderatedAt = DateTime.UtcNow;
        string reason = NormalizeNullable($"model_policy:{disposition.Reason}", 256) ?? disposition.Reason;
        AutomaticModerationTarget? target = await LoadAutomaticModerationTargetAsync(comment.Id, cancellationToken);
        if (target is null || target.ModerationStatus != previousStatus)
        {
            logger.LogInformation(
                "模型审核自动处置未应用，评论状态已变化 | CommentId: {CommentId} | Previous: {PreviousStatus} | Current: {CurrentStatus} | Next: {NextStatus}",
                comment.Id,
                previousStatus,
                target?.ModerationStatus,
                disposition.NextStatus);
            return;
        }

        bool applied = await TryApplyAutomaticModerationDispositionAsync(target, disposition.NextStatus, reason, moderatedAt);
        if (!applied)
        {
            AutomaticModerationTarget? latest = await LoadAutomaticModerationTargetAsync(comment.Id, cancellationToken);
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

            applied = await TryApplyAutomaticModerationDispositionAsync(latest, disposition.NextStatus, reason, moderatedAt);
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
        WriteAutomaticDispositionAudit(comment, disposition);
    }

    private async Task<AutomaticModerationTarget?> LoadAutomaticModerationTargetAsync(long commentId, CancellationToken cancellationToken)
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
            reader.GetInt64(0),
            (CommentModerationStatus)reader.GetInt32(1),
            reader.GetString(2));
    }

    private async Task<bool> TryApplyAutomaticModerationDispositionAsync(
        AutomaticModerationTarget target,
        CommentModerationStatus nextStatus,
        string reason,
        DateTime moderatedAt)
    {
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET moderation_status = @NextStatus,
                moderation_reason = @Reason,
                moderated_by_admin_principal_id = NULL,
                moderated_at = CAST(@ModeratedAt AS timestamp)
            WHERE id = @CommentId
              AND is_deleted = false
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@CommentId", target.Id),
            new SugarParameter("@NextStatus", (int)nextStatus),
            new SugarParameter("@Reason", reason),
            new SugarParameter("@ModeratedAt", moderatedAt),
            new SugarParameter("@RowVersion", target.RowVersion));
        return affected > 0;
    }

    private sealed record AutomaticModerationTarget(
        long Id,
        CommentModerationStatus ModerationStatus,
        string RowVersion);

    private void WriteAutomaticDispositionAudit(Comment comment, CommentModerationDisposition disposition)
    {
        if (auditLogChannel is null)
        {
            return;
        }

        string context = JsonSerializer.Serialize(disposition.AuditContext);
        auditLogChannel.TryWrite(new AuditRecord(
            AuditSourceCatalog.Comment,
            AuditTypeCatalog.Business,
            DateTime.UtcNow,
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

    public Task<bool> CreateAttributablePublicCommentAsync(
        AccountPrincipalContext account,
        CommentCreateV2RequestCoreModel request,
        RegionModerationDecision? regionDecision = null)
    {
        if (account.AccountId <= 0 ||
            !request.PublicSendExplicitlySelected ||
            !string.Equals(request.AuthorMode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            return Task.FromResult(false);
        }

        return CreateCommentAsync(account.AccountId, new CommentDto
        {
            ArticleId = request.ArticleId,
            Content = request.Content,
            ParentId = request.ParentId,
            RootId = request.RootId,
            ReplyToCommentId = request.ReplyToCommentId,
            ReplyToUserId = null,
            AuthorMode = CommentAuthorModes.Public,
            PublicSendExplicitlySelected = true,
            AnonymousScope = null,
            DisplayLanguage = request.DisplayLanguage,
            ProofToken = null,
            ZkProof = null,
            RegionDecision = regionDecision
        });
    }

    public async Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(
        int articleId,
        CursorPageRequest<long> request,
        int previewLimit = DefaultReplyPreviewLimit,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0)
        {
            return new CursorResponse<CommentThreadItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        int normalizedPreviewLimit = Math.Clamp(previewLimit, 1, 10);

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        List<ThreadRootRow> roots = await QueryThreadRootsAsync(articleId, request, normalizedViewerRegion);

        int rootWindowCount = CursorPagination.WindowCount(roots, request.Limit);
        long[] rootIds = new long[rootWindowCount];
        for (int i = 0; i < rootWindowCount; i++)
        {
            rootIds[i] = roots[i].Id;
        }

        Dictionary<long, List<CommentReplyPreviewItemDto>> previewMap = await QueryThreadRepliesPreviewMapAsync(articleId, rootIds, normalizedPreviewLimit + 1, normalizedViewerRegion);

        return CursorPagination.SliceMapToResponse(roots, request.Limit, root => root.Id, root =>
        {
            long rootId = root.Id;
            List<CommentReplyPreviewItemDto> loadedReplies = previewMap.GetValueOrDefault(rootId, []);
            bool hasMoreReplies = loadedReplies.Count > normalizedPreviewLimit;
            List<CommentReplyPreviewItemDto> previewReplies = hasMoreReplies
                ? loadedReplies.Take(normalizedPreviewLimit).ToList()
                : loadedReplies;
            int replyCount = previewReplies.Count + (hasMoreReplies ? 1 : 0);

            return new CommentThreadItemDto(
                root.Id.ToString(),
                ToDisplayContent(root.IsDeleted, root.Content),
                root.CreateTime,
                BuildAuthorView(root.AuthorMode, root.AuthorDisplayName, root.AnonymousDisplayLanguage, root.AnonymousScope, root.CredentialLevel),
                rootId.ToString(),
                root.IsDeleted,
                replyCount,
                hasMoreReplies,
                previewReplies);
        }, CursorCodec);
    }

    public async Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0 || rootId <= 0)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        bool rootExists = await QueryVisibleThreadRootExistsAsync(articleId, rootId, normalizedViewerRegion);
        if (!rootExists)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        List<ReplyRow> rows = await QueryThreadRepliesAsync(articleId, rootId, request, normalizedViewerRegion);

        return CursorPagination.SliceMapToResponse(rows, request.Limit, row => row.Id, MapReplyRow, CursorCodec);
    }

    public async Task<CursorResponse<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, CursorPageRequest<long> request)
    {
        CursorResponse<CommentThreadItemDto> threads = await GetCommentThreadsByCursorAsync(articleId, request, 1);
        var data = new List<CommentQueryResultDto>(threads.Data.Count);
        foreach (CommentThreadItemDto item in threads.Data)
        {
            data.Add(new CommentQueryResultDto(
                long.TryParse(item.Id, out long id) ? id : 0,
                item.Content,
                item.CreateTime,
                item.Author));
        }

        return new CursorResponse<CommentQueryResultDto>
        {
            Data = data,
            NextCursor = threads.NextCursor,
            HasMore = threads.HasMore
        };
    }

    public async Task<CursorResponse<UserCommentResponse>> GetAttributableCommentsAsync(int userId, CursorPageRequest<long> request)
    {
        if (userId <= 0)
        {
            return new CursorResponse<UserCommentResponse> { Data = [], NextCursor = null, HasMore = false };
        }

        var rows = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, crc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == crc.CommentId
            })
            .Where((c, a, pc, crc) => c.UserId == userId
                && c.AuthorMode == CommentAuthorModes.Public
                && !a.IsDeleted)
            .WhereIF(request.Cursor.HasValue, (c, a, pc, crc) => c.Id < request.Cursor!.Value)
            .OrderByDescending((c, a, pc, crc) => c.Id)
            .Take(request.Limit + 1)
            .Select((c, a, pc, crc) => new UserCommentRow
            {
                Id = c.Id,
                Content = c.Content,
                CreateTime = c.CreateTime,
                IsDeleted = c.IsDeleted,
                ModerationStatus = c.ModerationStatus,
                BlockedRegions = crc.BlockedRegions,
                RootId = c.RootId,
                ArticleId = a.Id,
                ArticleTitle = a.Title,
                ReplyToCommentId = c.ReplyToCommentId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                AnonymousScope = c.AnonymousScope,
                CredentialLevel = c.CredentialLevel,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage
            })
            .ToListAsync();

        return CursorPagination.SliceMapToResponse(rows, request.Limit, item => item.Id, item => CommentProjection.ToResponse(new UserCommentReadModel
        {
            Id = item.Id,
            Content = ToDisplayContent(item.IsDeleted, item.Content),
            CreateTime = item.CreateTime,
            ArticleId = item.ArticleId,
            ArticleTitle = item.ArticleTitle ?? string.Empty,
            RootId = item.RootId,
            Author = BuildAuthorView(item.AuthorMode, item.PublicHandle, item.AnonymousDisplayLanguage, item.AnonymousScope, item.CredentialLevel),
            ReplyToAuthor = item.ReplyToCommentId.HasValue
                ? BuildAuthorView(item.ReplyToAuthorMode, item.ReplyToPublicHandle, item.ReplyToAnonymousDisplayLanguage, null, null)
                : null,
            ModerationStatus = (int)item.ModerationStatus,
            IsDeleted = item.IsDeleted,
            HasBlockedRegions = !string.IsNullOrWhiteSpace(item.BlockedRegions)
        }), CursorCodec);
    }

    public Task<bool> DeleteCommentAsAccountAsync(long id, int accountId, string reason = "违反社区管理条例")
    {
        if (accountId <= 0)
        {
            return Task.FromResult(false);
        }

        return DeleteCommentAsync(id, accountId, isAdmin: false, reason);
    }

    public Task<bool> DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor, string reason = "违反社区管理条例")
    {
        if (actor.AdminPrincipalId <= 0 || string.IsNullOrWhiteSpace(actor.AdminSessionId))
        {
            return Task.FromResult(false);
        }

        return DeleteCommentAsync(id, currentUserId: 0, isAdmin: true, reason);
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
        => DeleteCommentInternalAsync(id, currentUserId, isAdmin, reason);

    private async Task<bool> DeleteCommentInternalAsync(long id, int currentUserId, bool isAdmin, string reason)
    {
        DateTime deletedAt = DateTime.UtcNow;
        string? normalizedReason = NormalizeNullable(reason, 256);
        DeleteCommentRow? row = null;
        bool isAttributableUserComment = false;
        bool deleted = false;
        var result = await db.Ado.UseTranAsync(async () =>
        {
            row = await LoadDeleteCommentRowAsync(id);
            if (row is null)
            {
                return;
            }

            isAttributableUserComment = IsAttributableUserComment(row.AuthorMode, row.UserId);
            if ((!isAttributableUserComment || row.UserId != currentUserId) && !isAdmin)
            {
                return;
            }

            if (row.IsDeleted)
            {
                return;
            }

            deleted = await TrySoftDeleteCommentAsync(row.Id, row.RowVersion, reason, normalizedReason, deletedAt);
        });
        if (!result.IsSuccess || row is null)
        {
            return false;
        }

        if (!deleted)
        {
            return false;
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: row.ArticleId,
                RootId: row.RootId ?? row.Id,
                AccountId: isAttributableUserComment ? row.UserId : null,
                PublicArticleChanged: true,
                UserCommentsChanged: isAttributableUserComment));
        await messageService.PushCommentRemoveAsync(row.ArticleId, id, row.RootId ?? id, row.ParentId);

        if (isAdmin && isAttributableUserComment && currentUserId != row.UserId!.Value)
        {
            string commentSnippet = row.Content.Length > 20 ? row.Content[..20] : row.Content;
            _ = NotifyDeletionAsync(row.UserId.Value, row.ArticleTitle ?? "未知文章", commentSnippet, reason);
        }

        logger.LogInformation("评论软删除成功 | CommentId: {CommentId} | Article: {ArticleId} | Root: {RootId} | Parent: {ParentId}",
            id,
            row.ArticleId,
            row.RootId ?? id,
            row.ParentId);

        return true;
    }

    private async Task<DeleteCommentRow?> LoadDeleteCommentRowAsync(long id)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT c.id,
                   c.user_id,
                   c.article_id,
                   c.parent_id,
                   c.root_id,
                   c.content,
                   c.is_deleted,
                   c.author_mode,
                   a.title,
                   c.xmin::text AS row_version
            FROM comment c
            INNER JOIN article a ON c.article_id = a.id
            WHERE c.id = @CommentId
              AND a.isdeleted = false
            FOR UPDATE OF c;
            """,
            new SugarParameter("@CommentId", id));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new DeleteCommentRow(
            reader.GetInt64(0),
            reader.IsDBNull(1) ? null : reader.GetInt32(1),
            reader.GetInt32(2),
            reader.IsDBNull(3) ? null : reader.GetInt64(3),
            reader.IsDBNull(4) ? null : reader.GetInt64(4),
            reader.GetString(5),
            reader.GetBoolean(6),
            reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.GetString(9));
    }

    private async Task<bool> TrySoftDeleteCommentAsync(
        long id,
        string rowVersion,
        string reason,
        string? normalizedReason,
        DateTime deletedAt)
    {
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET is_deleted = true,
                delete_reason = @Reason,
                delete_time = CAST(@DeletedAt AS timestamp),
                moderation_status = @ModerationStatus,
                moderation_reason = @ModerationReason
            WHERE id = @CommentId
              AND is_deleted = false
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@CommentId", id),
            new SugarParameter("@RowVersion", rowVersion),
            new SugarParameter("@Reason", reason),
            new SugarParameter("@DeletedAt", deletedAt),
            new SugarParameter("@ModerationStatus", (int)CommentModerationStatus.Hidden),
            new SugarParameter("@ModerationReason", (object?)normalizedReason ?? DBNull.Value));
        return affected > 0;
    }

    private sealed record DeleteCommentRow(
        long Id,
        int? UserId,
        int ArticleId,
        long? ParentId,
        long? RootId,
        string Content,
        bool IsDeleted,
        string AuthorMode,
        string? ArticleTitle,
        string RowVersion);

    private async Task<List<ThreadRootRow>> QueryThreadRootsAsync(
        int articleId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder("""
SELECT
    c.id AS "Id",
    c.article_id AS "ArticleId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    CASE
        WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
    END AS "AuthorDisplayName",
    c.author_mode AS "AuthorMode",
    c.anonymous_display_language AS "AnonymousDisplayLanguage",
    c.anonymous_scope AS "AnonymousScope",
    c.credential_level AS "CredentialLevel",
    c.depth AS "Depth",
    c.is_deleted AS "IsDeleted"
FROM comment c
WHERE c.article_id = @ArticleId
  AND c.parent_id IS NULL
  AND c.moderation_status = @Approved
  AND c.is_deleted = false
  AND NOT EXISTS (
      SELECT 1
      FROM comment_blocked_region br
      WHERE br.comment_id = c.id
        AND (
            @ConservativeUnknownViewer = true
            OR br.region_code = @ViewerRegion
        )
  )
""");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@Limit", request.Limit + 1));
        if (request.Cursor.HasValue)
        {
            sql.AppendLine("  AND c.id < @Cursor");
            parameters.Add(new SugarParameter("@Cursor", request.Cursor.Value));
        }

        sql.AppendLine("ORDER BY c.id DESC");
        sql.AppendLine("LIMIT @Limit;");

        var rows = new List<ThreadRootRow>(request.Limit + 1);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fArticleId = reader.GetOrdinal("ArticleId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
            int fCredentialLevel = reader.GetOrdinal("CredentialLevel");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ThreadRootRow
                {
                    Id = reader.GetInt64(fId),
                    ArticleId = reader.GetInt32(fArticleId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                    CredentialLevel = reader.IsDBNull(fCredentialLevel) ? null : reader.GetString(fCredentialLevel),
                    Depth = reader.IsDBNull(fDepth) ? 1 : reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        return rows;
    }

    private async Task<bool> QueryVisibleThreadRootExistsAsync(
        int articleId,
        long rootId,
        string normalizedViewerRegion)
    {
        const string sql = """
SELECT 1
FROM comment c
WHERE c.id = @RootId
  AND c.article_id = @ArticleId
  AND c.parent_id IS NULL
  AND c.moderation_status = @Approved
  AND c.is_deleted = false
  AND NOT EXISTS (
      SELECT 1
      FROM comment_blocked_region br
      WHERE br.comment_id = c.id
        AND (
            @ConservativeUnknownViewer = true
            OR br.region_code = @ViewerRegion
        )
  )
LIMIT 1;
""";
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@RootId", rootId));

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        return await reader.ReadAsync();
    }

    private async Task<List<ReplyRow>> QueryThreadRepliesAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder("""
SELECT
    c.id AS "Id",
    c.parent_id AS "ParentId",
    c.root_id AS "RootId",
    c.reply_to_comment_id AS "ReplyToCommentId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    CASE
        WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
    END AS "AuthorDisplayName",
    c.author_mode AS "AuthorMode",
    c.anonymous_display_language AS "AnonymousDisplayLanguage",
    c.anonymous_scope AS "AnonymousScope",
    c.credential_level AS "CredentialLevel",
    CASE
        WHEN pc.id IS NULL THEN NULL
        WHEN pc.author_mode = 'public' THEN COALESCE(NULLIF(pc.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(pc.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(pc.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(pc.anonymous_display_name, ''), '匿名用户')
    END AS "ReplyToDisplayName",
    pc.author_mode AS "ReplyToAuthorMode",
    pc.anonymous_display_language AS "ReplyToAnonymousDisplayLanguage",
    pc.anonymous_scope AS "ReplyToAnonymousScope",
    pc.credential_level AS "ReplyToCredentialLevel",
    c.depth AS "Depth",
    c.is_deleted AS "IsDeleted"
FROM comment c
LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
WHERE c.article_id = @ArticleId
  AND c.root_id = @RootId
  AND c.parent_id IS NOT NULL
  AND c.moderation_status = @Approved
  AND c.is_deleted = false
  AND NOT EXISTS (
      SELECT 1
      FROM comment_blocked_region br
      WHERE br.comment_id = c.id
        AND (
            @ConservativeUnknownViewer = true
            OR br.region_code = @ViewerRegion
        )
  )
""");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@RootId", rootId));
        parameters.Add(new SugarParameter("@Limit", request.Limit + 1));
        if (request.Cursor.HasValue)
        {
            sql.AppendLine("  AND c.id > @Cursor");
            parameters.Add(new SugarParameter("@Cursor", request.Cursor.Value));
        }

        sql.AppendLine("ORDER BY c.id");
        sql.AppendLine("LIMIT @Limit;");

        var rows = new List<ReplyRow>(request.Limit + 1);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fParentId = reader.GetOrdinal("ParentId");
            int fRootId = reader.GetOrdinal("RootId");
            int fReplyToCommentId = reader.GetOrdinal("ReplyToCommentId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
            int fCredentialLevel = reader.GetOrdinal("CredentialLevel");
            int fReplyToDisplayName = reader.GetOrdinal("ReplyToDisplayName");
            int fReplyToAuthorMode = reader.GetOrdinal("ReplyToAuthorMode");
            int fReplyToAnonymousDisplayLanguage = reader.GetOrdinal("ReplyToAnonymousDisplayLanguage");
            int fReplyToAnonymousScope = reader.GetOrdinal("ReplyToAnonymousScope");
            int fReplyToCredentialLevel = reader.GetOrdinal("ReplyToCredentialLevel");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ReplyRow
                {
                    Id = reader.GetInt64(fId),
                    ParentId = reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
                    RootId = reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
                    ReplyToCommentId = reader.IsDBNull(fReplyToCommentId) ? null : reader.GetInt64(fReplyToCommentId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                    CredentialLevel = reader.IsDBNull(fCredentialLevel) ? null : reader.GetString(fCredentialLevel),
                    ReplyToDisplayName = reader.IsDBNull(fReplyToDisplayName) ? null : reader.GetString(fReplyToDisplayName),
                    ReplyToAuthorMode = reader.IsDBNull(fReplyToAuthorMode) ? null : reader.GetString(fReplyToAuthorMode),
                    ReplyToAnonymousDisplayLanguage = reader.IsDBNull(fReplyToAnonymousDisplayLanguage) ? null : reader.GetString(fReplyToAnonymousDisplayLanguage),
                    ReplyToAnonymousScope = reader.IsDBNull(fReplyToAnonymousScope) ? null : reader.GetString(fReplyToAnonymousScope),
                    ReplyToCredentialLevel = reader.IsDBNull(fReplyToCredentialLevel) ? null : reader.GetString(fReplyToCredentialLevel),
                    Depth = reader.IsDBNull(fDepth) ? 2 : reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        return rows;
    }

    private static List<SugarParameter> BuildPublicCommentReadParameters(
        int articleId,
        string normalizedViewerRegion)
        => new(4)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@ViewerRegion", normalizedViewerRegion),
            new("@ConservativeUnknownViewer", normalizedViewerRegion == RegionCodes.Unknown)
        };

    private async Task<Dictionary<long, List<CommentReplyPreviewItemDto>>> QueryThreadRepliesPreviewMapAsync(
        int articleId,
        long[] rootIds,
        int limit,
        string viewerRegion)
    {
        if (rootIds.Length == 0)
        {
            return [];
        }

        var sql = new StringBuilder("""
SELECT
    x.id AS "Id",
    x.parent_id AS "ParentId",
    x.root_id AS "RootId",
    x.reply_to_comment_id AS "ReplyToCommentId",
    x.content AS "Content",
    x.create_time AS "CreateTime",
    x.author_display_name AS "AuthorDisplayName",
    x.author_mode AS "AuthorMode",
    x.anonymous_display_language AS "AnonymousDisplayLanguage",
    x.anonymous_scope AS "AnonymousScope",
    x.credential_level AS "CredentialLevel",
    x.reply_to_display_name AS "ReplyToDisplayName",
    x.reply_to_author_mode AS "ReplyToAuthorMode",
    x.reply_to_anonymous_display_language AS "ReplyToAnonymousDisplayLanguage",
    x.reply_to_anonymous_scope AS "ReplyToAnonymousScope",
    x.reply_to_credential_level AS "ReplyToCredentialLevel",
    x.depth AS "Depth",
    x.is_deleted AS "IsDeleted"
FROM (
    SELECT
        c.id,
        c.parent_id,
        c.root_id,
        c.reply_to_comment_id,
        c.content,
        c.create_time,
        CASE
            WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
            WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
            ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
        END AS author_display_name,
        c.author_mode,
        c.anonymous_display_language,
        c.anonymous_scope,
        c.credential_level,
        CASE
            WHEN pc.id IS NULL THEN NULL
            WHEN pc.author_mode = 'public' THEN COALESCE(NULLIF(pc.public_handle, ''), '未署名用户')
            WHEN lower(COALESCE(pc.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(pc.anonymous_display_name, ''), 'Anonymous User')
            ELSE COALESCE(NULLIF(pc.anonymous_display_name, ''), '匿名用户')
        END AS reply_to_display_name,
        pc.author_mode AS reply_to_author_mode,
        pc.anonymous_display_language AS reply_to_anonymous_display_language,
        pc.anonymous_scope AS reply_to_anonymous_scope,
        pc.credential_level AS reply_to_credential_level,
        c.depth,
        c.is_deleted,
        ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id) AS rn
    FROM comment c
    LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
    WHERE c.article_id = @ArticleId
      AND c.root_id IS NOT NULL
      AND c.root_id IN (
""");
        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        var parameters = new List<SugarParameter>(rootIds.Length + 5)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@PreviewLimit", limit),
            new("@ViewerRegion", normalizedViewerRegion),
            new("@ConservativeUnknownViewer", normalizedViewerRegion == RegionCodes.Unknown)
        };
        for (int i = 0; i < rootIds.Length; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            string parameterName = $"@RootId{i}";
            sql.Append(parameterName);
            parameters.Add(new SugarParameter(parameterName, rootIds[i]));
        }

        sql.Append("""
)
      AND c.parent_id IS NOT NULL
      AND c.moderation_status = @Approved
      AND c.is_deleted = false
      AND NOT EXISTS (
          SELECT 1
          FROM comment_blocked_region br
          WHERE br.comment_id = c.id
            AND (
                @ConservativeUnknownViewer = true
                OR br.region_code = @ViewerRegion
            )
      )
) x
WHERE x.rn <= @PreviewLimit
ORDER BY x.root_id, x.id;
""");

        var rows = new List<ReplyRow>(Math.Min(rootIds.Length, MaxReplyPreviewRootIds) * limit);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fParentId = reader.GetOrdinal("ParentId");
            int fRootId = reader.GetOrdinal("RootId");
            int fReplyToCommentId = reader.GetOrdinal("ReplyToCommentId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
            int fCredentialLevel = reader.GetOrdinal("CredentialLevel");
            int fReplyToDisplayName = reader.GetOrdinal("ReplyToDisplayName");
            int fReplyToAuthorMode = reader.GetOrdinal("ReplyToAuthorMode");
            int fReplyToAnonymousDisplayLanguage = reader.GetOrdinal("ReplyToAnonymousDisplayLanguage");
            int fReplyToAnonymousScope = reader.GetOrdinal("ReplyToAnonymousScope");
            int fReplyToCredentialLevel = reader.GetOrdinal("ReplyToCredentialLevel");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ReplyRow
                {
                    Id = reader.GetInt64(fId),
                    ParentId = reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
                    RootId = reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
                    ReplyToCommentId = reader.IsDBNull(fReplyToCommentId) ? null : reader.GetInt64(fReplyToCommentId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                    CredentialLevel = reader.IsDBNull(fCredentialLevel) ? null : reader.GetString(fCredentialLevel),
                    ReplyToDisplayName = reader.IsDBNull(fReplyToDisplayName) ? null : reader.GetString(fReplyToDisplayName),
                    ReplyToAuthorMode = reader.IsDBNull(fReplyToAuthorMode) ? null : reader.GetString(fReplyToAuthorMode),
                    ReplyToAnonymousDisplayLanguage = reader.IsDBNull(fReplyToAnonymousDisplayLanguage) ? null : reader.GetString(fReplyToAnonymousDisplayLanguage),
                    ReplyToAnonymousScope = reader.IsDBNull(fReplyToAnonymousScope) ? null : reader.GetString(fReplyToAnonymousScope),
                    ReplyToCredentialLevel = reader.IsDBNull(fReplyToCredentialLevel) ? null : reader.GetString(fReplyToCredentialLevel),
                    Depth = reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        var map = new Dictionary<long, List<CommentReplyPreviewItemDto>>(rootIds.Length);
        foreach (ReplyRow row in rows)
        {
            long resolvedRootId = row.RootId ?? row.Id;
            if (!map.TryGetValue(resolvedRootId, out List<CommentReplyPreviewItemDto>? previews))
            {
                previews = [];
                map[resolvedRootId] = previews;
            }

            previews.Add(MapReplyPreviewRow(row));
        }

        return map;
    }

    private static CommentReplyItemDto MapReplyRow(ReplyRow row)
    {
        long resolvedRootId = row.RootId ?? row.Id;
        int viewDepth = Math.Min(2, Math.Max(1, row.Depth));

        return new CommentReplyItemDto(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope, row.CredentialLevel),
            BuildReplyToAuthorView(row),
            row.ParentId?.ToString(),
            resolvedRootId.ToString(),
            row.ReplyToCommentId?.ToString(),
            viewDepth,
            row.IsDeleted);
    }

    private static CommentReplyPreviewItemDto MapReplyPreviewRow(ReplyRow row)
        => new(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope, row.CredentialLevel),
            BuildReplyToAuthorView(row),
            row.IsDeleted);

    private static CommentAuthorViewDto? BuildReplyToAuthorView(ReplyRow row)
    {
        if (string.IsNullOrWhiteSpace(row.ReplyToDisplayName))
        {
            return null;
        }

        string mode = string.IsNullOrWhiteSpace(row.ReplyToAuthorMode)
            ? CommentAuthorModes.Public
            : row.ReplyToAuthorMode;
        return BuildAuthorView(
            mode,
            row.ReplyToDisplayName!,
            row.ReplyToAnonymousDisplayLanguage,
            row.ReplyToAnonymousScope,
            row.ReplyToCredentialLevel);
    }

    private static CommentAuthorViewDto BuildAuthorView(
        string? authorMode,
        string? displayName,
        string? displayLanguage,
        string? anonymousScope,
        string? credentialLevel)
    {
        string mode = NormalizeAuthorModeForView(authorMode);
        string fallbackName = string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal)
            ? "未署名用户"
            : ResolveAnonymousDisplayFallback(displayLanguage);
        string resolvedDisplayName = NormalizeNullable(displayName, 96) ?? fallbackName;

        return new CommentAuthorViewDto(
            mode,
            resolvedDisplayName,
            NormalizeAuthorDisplayLanguage(displayLanguage),
            null,
            string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal) ? null : NormalizeNullable(anonymousScope, 128),
            string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal) ? null : NormalizeNullable(credentialLevel, 32));
    }

    private static string NormalizeAuthorModeForView(string? authorMode)
    {
        string normalized = (authorMode ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        return normalized is CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous
            ? normalized
            : CommentAuthorModes.Anonymous;
    }

    private static string NormalizeAuthorDisplayLanguage(string? displayLanguage)
        => string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase) ? "en" : "zh-CN";

    private static string ResolveCommentAuthorDisplayName(
        string? authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousDisplayLanguage)
    {
        string mode = NormalizeAuthorModeForView(authorMode);
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            return NormalizeNullable(publicHandle, 96) ?? "未署名用户";
        }

        return NormalizeNullable(anonymousDisplayName, 96)
            ?? ResolveAnonymousDisplayFallback(anonymousDisplayLanguage);
    }

    private static string ResolveAnonymousDisplayFallback(string? displayLanguage)
        => string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase)
            ? "Anonymous User"
            : "匿名用户";

    private static string ToDisplayContent(bool isDeleted, string content)
        => isDeleted ? DeletedPlaceholder : content;

    private static string NormalizeCommentContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        return content.Trim();
    }

    private static bool IsCommentContentWithinLimit(string content)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= CommentLimits.ContentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= CommentLimits.ContentMaxUtf8Bytes;

    private static bool IsAttributableUserComment(string? authorMode, int? userId)
        => userId is > 0
            && string.Equals(authorMode, CommentAuthorModes.Public, StringComparison.Ordinal);

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private static CommentRegionCompliance BuildRegionCompliance(long commentId, RegionModerationDecision decision)
    {
        DateTime now = DateTime.UtcNow;
        return new CommentRegionCompliance
        {
            CommentId = commentId,
            SubmitRegion = NormalizeNullable(decision.SubmitRegion, 64) ?? RegionCodes.Unknown,
            SubmitRegionConfidence = Math.Clamp(decision.SubmitRegionConfidence, 0d, 1d),
            RegionProvider = NormalizeNullable(decision.RegionProvider, 64) ?? "unknown",
            SubmitIpHash = NormalizeNullable(decision.SubmitIpHash, 64),
            PolicyVersion = NormalizeNullable(decision.PolicyVersion, 64) ?? RegionLegalModerationService.CurrentPolicyVersion,
            CanPublish = decision.CanPublish,
            RequiresManualReview = decision.RequiresManualReview,
            HideUntilReviewed = decision.HideUntilReviewed,
            BlockedRegions = RegionLegalModerationService.SerializeRegions(decision.BlockedRegions),
            RiskLabels = string.Join(',', decision.RiskLabels
                .Where(static label => !string.IsNullOrWhiteSpace(label))
                .Select(static label => label.Trim())
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static label => label, StringComparer.Ordinal)),
            DecisionReason = NormalizeNullable(decision.DecisionReason, 256),
            RuleHitsJson = decision.RuleHits.Count == 0 ? null : JsonSerializer.Serialize(decision.RuleHits),
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };
    }

    private async Task ReplaceBlockedRegionsAsync(long commentId, IReadOnlyCollection<string> blockedRegions, CancellationToken cancellationToken)
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
                RegionCode = NormalizeNullable(region, 64) ?? RegionCodes.Unknown
            })];
        if (rows.Length > 0)
        {
            await db.Insertable(rows).ExecuteCommandAsync(cancellationToken);
        }
    }

    private async Task NotifyDeletionAsync(int userId, string articleTitle, string commentSnippet, string reason)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                await messageCommandService.SendCommentDeletedNoticeAsync(userId, articleTitle, commentSnippet, reason);
            },
            logger,
            $"comment-notify-delete:{userId}",
            LogLevel.Error);
    }

    private async Task NotifyReplyAsync(int userId, int articleId, string actor, string? targetDisplayName, string content)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                string targetName = string.IsNullOrWhiteSpace(targetDisplayName) ? "您" : targetDisplayName!;
                string snippet = content.Length > 40 ? content[..40] : content;
                await messageCommandService.SendAccountTransactionalNoticeAsync(userId, "收到新的评论回复", $"{actor} 回复了 {targetName}：{snippet}");
            },
            logger,
            $"comment-notify-reply:{userId}",
            LogLevel.Warning);
    }

    private sealed record ThreadRootRow
    {
        public long Id { get; init; }
        public int ArticleId { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public string AuthorDisplayName { get; init; } = string.Empty;
        public string? AuthorMode { get; init; }
        public string? AnonymousDisplayLanguage { get; init; }
        public string? AnonymousScope { get; init; }
        public string? CredentialLevel { get; init; }
        public int Depth { get; init; }
        public bool IsDeleted { get; init; }
    }

    private sealed record ReplyRow
    {
        public long Id { get; init; }
        public long? ParentId { get; init; }
        public long? RootId { get; init; }
        public long? ReplyToCommentId { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public string AuthorDisplayName { get; init; } = string.Empty;
        public string? AuthorMode { get; init; }
        public string? AnonymousDisplayLanguage { get; init; }
        public string? AnonymousScope { get; init; }
        public string? CredentialLevel { get; init; }
        public string? ReplyToDisplayName { get; init; }
        public string? ReplyToAuthorMode { get; init; }
        public string? ReplyToAnonymousDisplayLanguage { get; init; }
        public string? ReplyToAnonymousScope { get; init; }
        public string? ReplyToCredentialLevel { get; init; }
        public int Depth { get; init; }
        public bool IsDeleted { get; init; }
    }

    private sealed record UserCommentRow
    {
        public long Id { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public bool IsDeleted { get; init; }
        public CommentModerationStatus ModerationStatus { get; init; } = CommentModerationStatus.Approved;
        public string? BlockedRegions { get; init; }
        public long? RootId { get; init; }
        public int ArticleId { get; init; }
        public string? ArticleTitle { get; init; }
        public long? ReplyToCommentId { get; init; }
        public string? AuthorMode { get; init; }
        public string? PublicHandle { get; init; }
        public string? AnonymousDisplayName { get; init; }
        public string? AnonymousDisplayLanguage { get; init; }
        public string? AnonymousScope { get; init; }
        public string? CredentialLevel { get; init; }
        public string? ReplyToAuthorMode { get; init; }
        public string? ReplyToPublicHandle { get; init; }
        public string? ReplyToAnonymousDisplayName { get; init; }
        public string? ReplyToAnonymousDisplayLanguage { get; init; }
    }
}
