using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
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

public partial class CommentCommandService(
    ISqlSugarClient db,
    ILogger<CommentCommandService> logger,
    ICommentNotificationService commentNotifications,
    ICommentModerationService commentModeration,
    ICommentAttributionPrivacyService commentAttribution,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IConfiguration? configuration = null,
    ICommentMutationOutbox? mutationOutbox = null,
    IArticleCommentPolicyService? articleCommentPolicy = null,
    TimeProvider? timeProvider = null) : ICommentEndpointService, ICommentCommandService
{
    internal const int DefaultMaxThreadDepth = 32;
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;
    private const int DefaultMaxChildrenPerNode = 500;
    private const int DefaultMutationTtlHours = 24;

    private static readonly TimeSpan s_shortOperationTimeout = TimeSpan.FromSeconds(5);

    private sealed record CommentMutationCommand(
        int? AccountId,
        string? ClientMutationId,
        string? AnonymousTicketHash,
        string RequestHash,
        DateTime ExpiresAtUtc)
    {
        public string PrincipalKind => AccountId.HasValue ? "account" : "anonymous-ticket";
        public string PrincipalIdentity => AccountId?.ToString(CultureInfo.InvariantCulture) ?? AnonymousTicketHash!;
    }

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
        RegionModerationDecision regionDecision = commentModeration.ResolveSubmissionRegion(
            normalizedContent,
            dto.ArticleId,
            userId,
            dto.RegionDecision);
        if (!regionDecision.CanPublish)
        {
            return false;
        }

        using var timeout = TimeoutCancellationScope.Create(s_shortOperationTimeout);

        CommentActor? actor = await commentAttribution.ResolvePublicActorAsync(
            userId,
            dto,
            normalizedContent,
            regionDecision.SubmitRegion,
            timeout.Token);
        if (actor is null)
        {
            return false;
        }

        CommentCreateResult result = await CreateResolvedCommentAsync(
            dto.ArticleId,
            normalizedContent,
            dto.ParentId,
            dto.RootId,
            dto.ReplyToCommentId,
            actor,
            regionDecision,
            timeout.Token);
        return result.Created;
    }

    public async Task<bool> CreateStrongAnonymousCommentAsync(
        AnonymousCommentCreateRequestCoreModel request,
        RegionModerationDecision? regionDecision = null,
        CancellationToken cancellationToken = default)
    {
        CommentCreateResult result = await CreateStrongAnonymousCommentResultAsync(request, regionDecision, cancellationToken);
        return result.Created;
    }

    public async Task<CommentCreateResult> CreateStrongAnonymousCommentResultAsync(
        AnonymousCommentCreateRequestCoreModel request,
        RegionModerationDecision? regionDecision = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.ArticleId <= 0)
        {
            return CommentCreateResult.Failed;
        }

        string normalizedContent = NormalizeCommentContent(request.Content);
        string ticketHash = AnonymousCommentTicketService.HashTicket(request.Ticket);
        string requestHash = ComputeCommentMutationRequestHash(
            request.ArticleId,
            normalizedContent,
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            request.AnonymousScope,
            request.DisplayLanguage);
        CommentMutationCommand mutation = CreateAnonymousMutation(ticketHash, requestHash);
        CommentCreateResult existing = await TryResolveExistingMutationAsync(mutation, cancellationToken);
        if (existing.Created)
        {
            return existing;
        }
        if (string.Equals(existing.FailureCode, "comment_mutation_content_conflict", StringComparison.Ordinal))
        {
            return existing;
        }

        AnonymousCommentTicketPayload? ticket = await commentAttribution.ReadStrongAnonymousTicketAsync(
            request,
            normalizedContent,
            cancellationToken);
        if (ticket is null)
        {
            return await ResolveMutationAfterIdentityMissAsync(mutation, cancellationToken);
        }

        RegionModerationDecision effectiveRegionDecision = commentModeration.ResolveSubmissionRegion(
            normalizedContent,
            request.ArticleId,
            0,
            regionDecision);
        if (!effectiveRegionDecision.CanPublish)
        {
            return CommentCreateResult.Failed;
        }

        CommentActor? actor = await commentAttribution.ResolveStrongAnonymousActorAsync(
            ticket,
            request,
            effectiveRegionDecision.SubmitRegion,
            cancellationToken);
        if (actor is null)
        {
            return CommentCreateResult.Failed;
        }

        CommentManagementCapability managementCapability =
            CommentManagementCapabilityService.CreateCapability();

        CommentCreateResult result = await CreateResolvedCommentAsync(
            request.ArticleId,
            normalizedContent,
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            actor,
            effectiveRegionDecision,
            cancellationToken,
            mutation,
            managementCapability);
        if (result.Created)
        {
            try
            {
                await commentAttribution.FinalizeStrongAnonymousTicketAsync(request, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "匿名评论已提交但 ticket 消费清理失败 | CommentId: {CommentId}", result.CommentId);
            }
        }

        return result;
    }

    private async Task<CommentCreateResult> CreateResolvedCommentAsync(
        int articleId,
        string normalizedContent,
        string? requestedParentId,
        string? requestedRootIdRaw,
        string? requestedReplyToCommentIdRaw,
        CommentActor actor,
        RegionModerationDecision regionDecision,
        CancellationToken cancellationToken,
        CommentMutationCommand? mutation = null,
        CommentManagementCapability? managementCapability = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime now = _clock.GetUtcNow().UtcDateTime;
        bool articleExists = await db.Queryable<Article>()
            .Where(a => a.Id == articleId
                && !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .AnyAsync();
        if (!articleExists)
        {
            return CommentCreateResult.Failed;
        }

        if (!regionDecision.CanPublish)
        {
            return CommentCreateResult.Failed;
        }

        bool enforceAnonymousNullifier = commentAttribution.RequiresAnonymousNullifierEnforcement(actor);
        if (enforceAnonymousNullifier && !commentAttribution.CanEnforceAnonymousNullifier)
        {
            logger.LogWarning(
                "匿名评论 nullifier enforcement 未注册，拒绝评论写入 | Article: {ArticleId} | ScopeHash: {ScopeHash}",
                articleId,
                commentAttribution.HashAnonymousScopeForLog(actor.AnonymousScope));
            return CommentCreateResult.Failed;
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
                return CommentCreateResult.Failed;
            }

            long? requestedRootId = null;
            if (!string.IsNullOrWhiteSpace(requestedRootIdRaw))
            {
                if (!TryParsePositiveCommentId(requestedRootIdRaw, out long parsedRootId))
                {
                    return CommentCreateResult.Failed;
                }

                requestedRootId = parsedRootId;
            }

            long? requestedReplyToCommentId = null;
            if (!string.IsNullOrWhiteSpace(requestedReplyToCommentIdRaw))
            {
                if (!TryParsePositiveCommentId(requestedReplyToCommentIdRaw, out long parsedReplyToCommentId))
                {
                    return CommentCreateResult.Failed;
                }

                requestedReplyToCommentId = parsedReplyToCommentId;
            }

            ReplyTargetRow? parent = await LoadVisibleReplyTargetAsync(parsedParentId, articleId, cancellationToken);
            if (parent is null)
            {
                return CommentCreateResult.Failed;
            }

            int maxDepth = Math.Clamp(
                configuration?.GetValue("CommentThreads:MaxDepth", DefaultMaxThreadDepth) ?? DefaultMaxThreadDepth,
                2,
                256);
            if (parent.Depth + 1 > maxDepth)
            {
                logger.LogInformation(
                    "评论回复超过线程深度上限 | Article: {ArticleId} | Parent: {ParentId} | Depth: {Depth} | MaxDepth: {MaxDepth}",
                    articleId,
                    parent.Id,
                    parent.Depth + 1,
                    maxDepth);
                return CommentCreateResult.Failure("comment_thread_depth_limit");
            }

            parentId = parent.Id;
            rootId = parent.RootId ?? parent.Id;
            if (requestedRootId.HasValue && requestedRootId.Value != rootId.Value)
            {
                return CommentCreateResult.Failed;
            }

            replyToUserId = ResolveReplyRecipientId(parent.UserId, actor.UserId);
            replyToCommentId = parent.Id;
            if (requestedReplyToCommentId.HasValue && requestedReplyToCommentId.Value != replyToCommentId.Value)
            {
                return CommentCreateResult.Failed;
            }

            depth = Math.Max(1, parent.Depth + 1);
        }

        CommentInitialModerationDecision initialModeration = commentModeration.ResolveInitialState(actor, regionDecision);
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
            CredentialLevel = null,
            ReputationBucket = null,
            AccountAgeBucket = null,
            AnonymousRateClass = actor.RateClass,
            AnonymousRequiresModeration = actor.RequiresModeration,
            CreateTime = _clock.GetUtcNow().UtcDateTime,
            ParentId = parentId,
            RootId = rootId,
            ReplyToUserId = replyToUserId,
            ReplyToCommentId = replyToCommentId,
            Depth = depth,
            IsDeleted = false,
            DeleteReason = null,
            DeleteTime = null,
            ModerationStatus = initialModeration.Status,
            ModerationReason = initialModeration.ReasonCode,
            ClientMutationAccountId = mutation?.AccountId,
            ClientMutationId = mutation?.ClientMutationId,
            AnonymousTicketHash = mutation?.AnonymousTicketHash,
            MutationRequestHash = mutation?.RequestHash,
            MutationExpiresAtUtc = mutation?.ExpiresAtUtc,
            CurrentVersion = 1,
            EditedAtUtc = null,
            ManagementCapabilityHash = managementCapability?.Commitment
        };

        long generatedId = 0;
        CommentCreateResult replayResult = CommentCreateResult.Failed;
        bool mutationConflict = false;
        var insertResult = await db.Ado.UseTranAsync(async () =>
        {
            if (mutation is not null)
            {
                await AcquireCommentMutationLockAsync(mutation, cancellationToken);
                Comment? existingMutation = await FindCommentMutationAsync(mutation);
                if (existingMutation is not null && existingMutation.MutationExpiresAtUtc > now)
                {
                    if (string.Equals(existingMutation.MutationRequestHash, mutation.RequestHash, StringComparison.Ordinal))
                    {
                        replayResult = BuildCreateResult(existingMutation, idempotencyReplay: true);
                    }
                    else
                    {
                        mutationConflict = true;
                    }
                    return;
                }

                if (existingMutation is not null)
                {
                    await ClearExpiredMutationIdentityAsync(existingMutation.Id, cancellationToken);
                }
            }

            if (!await LockVisibleCommentTargetAsync(articleId, parentId, rootId, now, cancellationToken))
            {
                throw new CommentTargetNotVisibleException();
            }

            CommentPolicyWriteDecision? policyDecision = articleCommentPolicy is null
                ? null
                : await articleCommentPolicy.ValidateWriteAsync(
                    articleId,
                    rootId,
                    actor.AuthorMode,
                    actor.ModerationSubjectHash,
                    consumeSlowMode: true,
                    cancellationToken);
            if (policyDecision is { Allowed: false })
            {
                throw new CommentPolicyRejectedException(policyDecision.Status);
            }
            if (policyDecision is not null && string.Equals(policyDecision.Policy.ModerationMode, ArticleCommentModerationModes.Premoderated, StringComparison.Ordinal))
            {
                comment.ModerationStatus = CommentModerationStatus.Pending;
                comment.ModerationReason = "article_policy_premoderated";
            }

            if (parentId.HasValue && !await ReserveChildSlotAsync(parentId.Value, cancellationToken))
            {
                throw new CommentChildLimitExceededException();
            }

            if (comment.ReplyToUserId.HasValue
                && !await LockActiveReplyRecipientAsync(comment.ReplyToUserId.Value, cancellationToken))
            {
                comment.ReplyToUserId = null;
            }

            generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
            if (generatedId <= 0)
            {
                throw new InvalidOperationException("Failed to create comment id.");
            }

            await db.Insertable(new CommentRevision
            {
                CommentId = generatedId,
                Version = 1,
                Content = normalizedContent,
                ContentSha256 = ComputeContentSha256(normalizedContent),
                Operation = CommentRevisionOperations.Created,
                CreatedAtUtc = comment.CreateTime,
                ActorAccountId = actor.UserId,
                ActorAdminPrincipalId = null,
                ActorMode = actor.AuthorMode
            }).ExecuteCommandAsync(cancellationToken);

            await commentModeration.PersistVisibilityAsync(generatedId, regionDecision, cancellationToken);

            if (mutationOutbox is not null)
            {
                DateTime occurredAt = _clock.GetUtcNow().UtcDateTime;
                await db.Insertable(new CommentModerationEvent
                {
                    CommentId = generatedId,
                    EventType = CommentModerationEventTypes.Create,
                    PreviousStatus = null,
                    NextStatus = comment.ModerationStatus,
                    ActorType = actor.UserId is > 0 ? "account" : "anonymous",
                    ReasonCode = "comment_create",
                    TransitionSource = "create",
                    OccurredAtUtc = occurredAt
                }).ExecuteCommandAsync(cancellationToken);
                await mutationOutbox.EnqueueAsync(BuildOutboxEvent(
                    CommentMutationEventTypes.Created,
                    comment,
                    generatedId,
                    occurredAt,
                    previousStatus: null,
                    nextStatus: comment.ModerationStatus), cancellationToken);
                await mutationOutbox.EnqueueAsync(BuildOutboxEvent(
                    CommentMutationEventTypes.VisibilityChanged,
                    comment,
                    generatedId,
                    occurredAt,
                    previousStatus: null,
                    nextStatus: comment.ModerationStatus), cancellationToken);
                if (comment.ReplyToUserId is > 0 && comment.ModerationStatus == CommentModerationStatus.Approved)
                {
                    await mutationOutbox.EnqueueAsync(BuildOutboxEvent(
                        CommentMutationEventTypes.ReplyNotificationRequested,
                        comment,
                        generatedId,
                        occurredAt,
                        previousStatus: null,
                        nextStatus: comment.ModerationStatus), cancellationToken);
                }
            }

            if (enforceAnonymousNullifier)
            {
                NullifierReservationResult consume = await commentAttribution.ConsumeAnonymousNullifierAsync(
                    actor,
                    generatedId,
                    cancellationToken);
                if (!consume.Allowed)
                {
                    throw new AnonymousNullifierRejectedException(consume.Status, consume.Message);
                }
            }
        });
        if (mutationConflict)
        {
            return CommentCreateResult.Failure("comment_mutation_content_conflict");
        }
        if (replayResult.Created)
        {
            return replayResult;
        }
        if (!insertResult.IsSuccess || generatedId <= 0)
        {
            if (insertResult.ErrorException is AnonymousNullifierRejectedException rejected)
            {
                logger.LogInformation(
                    "匿名评论 nullifier enforcement 拒绝写入 | Article: {ArticleId} | ScopeHash: {ScopeHash} | Status: {Status}",
                    articleId,
                    commentAttribution.HashAnonymousScopeForLog(actor.AnonymousScope),
                    rejected.Status);
                await commentAttribution.RecordNullifierAbuseRiskSignalAsync(
                    actor.AnonymousScope,
                    rejected.Status,
                    cancellationToken);
                return CommentCreateResult.Failed;
            }

            if (insertResult.ErrorException is CommentTargetNotVisibleException)
            {
                return CommentCreateResult.Failed;
            }

            if (insertResult.ErrorException is CommentPolicyRejectedException policyRejected)
            {
                return CommentCreateResult.Failure(policyRejected.Status);
            }

            if (insertResult.ErrorException is CommentChildLimitExceededException)
            {
                logger.LogInformation(
                    "评论节点达到直接回复上限 | Article: {ArticleId} | Parent: {ParentId}",
                    articleId,
                    parentId);
                return CommentCreateResult.Failure("comment_child_limit");
            }

            logger.LogWarning(insertResult.ErrorException, "评论创建或地区合规记录写入失败 | Article: {ArticleId} | User: {UserId}", articleId, actor.UserId);
            return CommentCreateResult.Failed;
        }

        comment.Id = generatedId;
        if (mutationOutbox is not null)
        {
            logger.LogInformation(
                "评论权威状态与 Outbox 已提交 | Article: {ArticleId} | CommentId: {CommentId} | Root: {RootId} | Parent: {ParentId}",
                articleId,
                comment.Id,
                comment.RootId ?? comment.Id,
                comment.ParentId);
            return BuildCreateResult(comment, managementSecret: managementCapability?.Secret);
        }

        await commentModeration.ApplyPostInsertAsync(
            comment,
            new CommentModerationActorContext(
                actor.UserId,
                actor.AuthorMode,
                actor.DisplayLanguage,
                actor.ModerationSubjectHash,
                actor.AnonymousNullifierHash,
                actor.AnonymousScope,
                actor.RateClass,
                actor.RequiresModeration),
            regionDecision,
            cancellationToken);

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

        return BuildCreateResult(comment, managementSecret: managementCapability?.Secret);
    }

    private async Task<ReplyTargetRow?> LoadVisibleReplyTargetAsync(long parentId, int articleId, CancellationToken cancellationToken)
    {
        await using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                p.id AS "Id",
                p.article_id AS "ArticleId",
                p.root_id AS "RootId",
                p.parent_id AS "ParentId",
                p.depth AS "Depth",
                p.user_id AS "UserId"
            FROM comment p
            JOIN comment r
              ON r.id = COALESCE(p.root_id, p.id)
             AND r.article_id = p.article_id
             AND r.parent_id IS NULL
             AND r.moderation_status = @ApprovedStatus
             AND r.is_deleted = false
            WHERE p.id = @ParentId
              AND p.article_id = @ArticleId
              AND p.moderation_status = @ApprovedStatus
              AND p.is_deleted = false
            LIMIT 1;
            """,
            new SugarParameter("@ParentId", parentId),
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ApprovedStatus", (int)CommentModerationStatus.Approved));
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        int fRootId = reader.GetOrdinal("RootId");
        int fParentId = reader.GetOrdinal("ParentId");
        int fDepth = reader.GetOrdinal("Depth");
        int fUserId = reader.GetOrdinal("UserId");
        return new ReplyTargetRow(
            reader.GetInt64(reader.GetOrdinal("Id")),
            reader.GetInt32(reader.GetOrdinal("ArticleId")),
            reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
            reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
            reader.IsDBNull(fDepth) ? 0 : reader.GetInt32(fDepth),
            reader.IsDBNull(fUserId) ? null : reader.GetInt32(fUserId));
    }

    private async Task<bool> LockActiveReplyRecipientAsync(int accountId, CancellationToken cancellationToken)
    {
        await using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT 1
            FROM sys_user
            WHERE id = @AccountId
              AND status = 0
              AND deleted_at IS NULL
            FOR SHARE;
            """,
            new SugarParameter("@AccountId", accountId));
        return await reader.ReadAsync(cancellationToken);
    }

    private async Task<bool> ReserveChildSlotAsync(long parentId, CancellationToken cancellationToken)
    {
        int maxChildren = Math.Clamp(
            configuration?.GetValue("CommentThreads:MaxChildrenPerNode", DefaultMaxChildrenPerNode) ?? DefaultMaxChildrenPerNode,
            1,
            10_000);
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(@ParentId);",
            new SugarParameter("@ParentId", parentId));
        long childCount = await db.Queryable<Comment>()
            .Where(comment => comment.ParentId == parentId)
            .CountAsync();
        cancellationToken.ThrowIfCancellationRequested();
        return childCount < maxChildren;
    }

    public static int? ResolveReplyRecipientId(int? targetAuthorAccountId, int? replyingActorAccountId)
        => targetAuthorAccountId is > 0 && targetAuthorAccountId != replyingActorAccountId
            ? targetAuthorAccountId
            : null;

    private async Task<bool> LockVisibleCommentTargetAsync(
        int articleId,
        long? parentId,
        long? rootId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!parentId.HasValue)
        {
            await using var rootReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT 1
                FROM article a
                WHERE a.id = @ArticleId
                  AND a.isdeleted = false
                  AND a.status = @PublishedStatus
                  AND (a.published_at IS NULL OR a.published_at <= @Now)
                  AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
                FOR SHARE;
                """,
                new SugarParameter("@ArticleId", articleId),
                new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                new SugarParameter("@Now", utcNow));
            return await rootReader.ReadAsync(cancellationToken);
        }

        if (!rootId.HasValue)
        {
            return false;
        }

        await using var replyReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT 1
            FROM article a, comment pc, comment rc
            WHERE a.id = @ArticleId
              AND a.isdeleted = false
              AND a.status = @PublishedStatus
              AND (a.published_at IS NULL OR a.published_at <= @Now)
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)
              AND pc.id = @ParentId
              AND pc.article_id = a.id
              AND COALESCE(pc.root_id, pc.id) = @RootId
              AND pc.moderation_status = @ApprovedStatus
              AND pc.is_deleted = false
              AND rc.id = @RootId
              AND rc.article_id = a.id
              AND rc.parent_id IS NULL
              AND rc.moderation_status = @ApprovedStatus
              AND rc.is_deleted = false
            FOR SHARE
            LIMIT 1;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ParentId", parentId.Value),
            new SugarParameter("@RootId", rootId.Value),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@ApprovedStatus", (int)CommentModerationStatus.Approved),
            new SugarParameter("@Now", utcNow));
        return await replyReader.ReadAsync(cancellationToken);
    }

    private sealed record ReplyTargetRow(long Id, int ArticleId, long? RootId, long? ParentId, int Depth, int? UserId);

    private sealed class AnonymousNullifierRejectedException(string status, string message) : Exception(message)
    {
        public string Status { get; } = status;
    }

    private sealed class CommentTargetNotVisibleException : Exception
    {
    }

    private sealed class CommentChildLimitExceededException : Exception
    {
    }

    private sealed class CommentPolicyRejectedException(string status) : Exception(status)
    {
        public string Status { get; } = status;
    }

    public Task<CommentCreateResult> CreateAttributablePublicCommentResultAsync(
        AccountPrincipalContext account,
        CommentCreateRequestCoreModel request,
        RegionModerationDecision? regionDecision = null)
        => CreateAttributablePublicCommentResultAsync(
            account,
            request,
            Guid.NewGuid().ToString("D", CultureInfo.InvariantCulture),
            regionDecision);

    public Task<CommentCreateResult> CreateAttributablePublicCommentResultAsync(
        AccountPrincipalContext account,
        CommentCreateRequestCoreModel request,
        string clientMutationId,
        RegionModerationDecision? regionDecision = null)
    {
        if (account.AccountId <= 0 ||
            !request.PublicSendExplicitlySelected ||
            !string.Equals(request.AuthorMode, CommentAuthorModes.Public, StringComparison.Ordinal) ||
            !TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Task.FromResult(CommentCreateResult.Failed);
        }

        var dto = new CommentDto
        {
            ArticleId = request.ArticleId,
            Content = request.Content,
            ParentId = request.ParentId,
            RootId = request.RootId,
            ReplyToCommentId = request.ReplyToCommentId,
            AuthorMode = CommentAuthorModes.Public,
            PublicSendExplicitlySelected = true,
            AnonymousScope = null,
            DisplayLanguage = request.DisplayLanguage,
            ProofToken = null,
            ZkProof = null,
            RegionDecision = regionDecision
        };
        string requestHash = ComputeCommentMutationRequestHash(
            request.ArticleId,
            NormalizeCommentContent(request.Content),
            request.ParentId,
            request.RootId,
            request.ReplyToCommentId,
            CommentAuthorModes.Public,
            request.DisplayLanguage);
        return CreateAttributablePublicCommentCoreAsync(
            account.AccountId,
            dto,
            new CommentMutationCommand(
                account.AccountId,
                mutationId,
                null,
                requestHash,
                ResolveMutationExpiry()));
    }

    public async Task<bool> CreateAttributablePublicCommentAsync(
        AccountPrincipalContext account,
        CommentCreateRequestCoreModel request,
        RegionModerationDecision? regionDecision = null)
        => (await CreateAttributablePublicCommentResultAsync(account, request, regionDecision)).Created;

    private async Task<CommentCreateResult> CreateAttributablePublicCommentCoreAsync(
        int userId,
        CommentDto dto,
        CommentMutationCommand? mutation = null)
    {
        if (dto.ArticleId <= 0)
        {
            return CommentCreateResult.Failed;
        }

        string normalizedContent = NormalizeCommentContent(dto.Content);
        RegionModerationDecision regionDecision = commentModeration.ResolveSubmissionRegion(
            normalizedContent,
            dto.ArticleId,
            userId,
            dto.RegionDecision);
        if (!regionDecision.CanPublish)
        {
            return CommentCreateResult.Failed;
        }

        using var timeout = TimeoutCancellationScope.Create(s_shortOperationTimeout);

        CommentActor? actor = await commentAttribution.ResolvePublicActorAsync(
            userId,
            dto,
            normalizedContent,
            regionDecision.SubmitRegion,
            timeout.Token);
        return actor is null
            ? CommentCreateResult.Failed
            : await CreateResolvedCommentAsync(
                dto.ArticleId,
                normalizedContent,
                dto.ParentId,
                dto.RootId,
                dto.ReplyToCommentId,
                actor,
                regionDecision,
                timeout.Token,
                mutation);
    }

    private CommentMutationCommand CreateAnonymousMutation(string ticketHash, string requestHash)
        => new(null, null, ticketHash, requestHash, ResolveMutationExpiry());

    private DateTime ResolveMutationExpiry()
    {
        int hours = configuration?.GetValue("Comments:MutationIdempotencyTtlHours", DefaultMutationTtlHours)
            ?? DefaultMutationTtlHours;
        return _clock.GetUtcNow().UtcDateTime.AddHours(Math.Clamp(hours, 1, 168));
    }

    private static bool TryNormalizeClientMutationId(string? value, out string normalized)
    {
        normalized = string.Empty;
        string candidate = value?.Trim() ?? string.Empty;
        if (!Guid.TryParseExact(candidate, "D", out Guid mutationId))
        {
            return false;
        }

        normalized = mutationId.ToString("D", CultureInfo.InvariantCulture);
        return string.Equals(candidate, normalized, StringComparison.Ordinal);
    }

    private static string ComputeCommentMutationRequestHash(
        int articleId,
        string content,
        string? parentId,
        string? rootId,
        string? replyToCommentId,
        string? identityContext,
        string? displayLanguage)
    {
        string[] values =
        [
            articleId.ToString(CultureInfo.InvariantCulture),
            content,
            parentId?.Trim() ?? string.Empty,
            rootId?.Trim() ?? string.Empty,
            replyToCommentId?.Trim() ?? string.Empty,
            identityContext?.Trim() ?? string.Empty,
            displayLanguage?.Trim() ?? string.Empty
        ];
        var canonical = new StringBuilder();
        foreach (string value in values)
        {
            canonical.Append(value.Length.ToString(CultureInfo.InvariantCulture));
            canonical.Append(':');
            canonical.Append(value);
            canonical.Append(';');
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    private Task AcquireCommentMutationLockAsync(CommentMutationCommand mutation, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext(@PrincipalKind), hashtext(@MutationIdentity));",
            new SugarParameter("@PrincipalKind", mutation.PrincipalKind),
            new SugarParameter("@MutationIdentity", mutation.PrincipalIdentity));

    private async Task<Comment?> FindCommentMutationAsync(CommentMutationCommand mutation)
    {
        if (mutation.AccountId.HasValue)
        {
            int accountId = mutation.AccountId.Value;
            string clientMutationId = mutation.ClientMutationId!;
            return await db.Queryable<Comment>()
                .Where(item => item.ClientMutationAccountId == accountId
                    && item.ClientMutationId == clientMutationId)
                .FirstAsync();
        }

        string anonymousTicketHash = mutation.AnonymousTicketHash!;
        return await db.Queryable<Comment>()
            .Where(item => item.AnonymousTicketHash == anonymousTicketHash)
            .FirstAsync();
    }

    private async Task<CommentCreateResult> TryResolveExistingMutationAsync(
        CommentMutationCommand mutation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Comment? existing = await FindCommentMutationAsync(mutation);
        if (existing is null || existing.MutationExpiresAtUtc <= _clock.GetUtcNow().UtcDateTime)
        {
            return CommentCreateResult.Failed;
        }

        return string.Equals(existing.MutationRequestHash, mutation.RequestHash, StringComparison.Ordinal)
            ? BuildCreateResult(existing, idempotencyReplay: true)
            : CommentCreateResult.Failure("comment_mutation_content_conflict");
    }

    private async Task<CommentCreateResult> ResolveMutationAfterIdentityMissAsync(
        CommentMutationCommand mutation,
        CancellationToken cancellationToken)
    {
        CommentCreateResult result = CommentCreateResult.Failed;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireCommentMutationLockAsync(mutation, cancellationToken);
            Comment? existing = await FindCommentMutationAsync(mutation);
            if (existing is null || existing.MutationExpiresAtUtc <= _clock.GetUtcNow().UtcDateTime)
            {
                return;
            }

            result = string.Equals(existing.MutationRequestHash, mutation.RequestHash, StringComparison.Ordinal)
                ? BuildCreateResult(existing, idempotencyReplay: true)
                : CommentCreateResult.Failure("comment_mutation_content_conflict");
        });
        return transaction.IsSuccess ? result : CommentCreateResult.Failed;
    }

    private Task ClearExpiredMutationIdentityAsync(long commentId, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET client_mutation_account_id = NULL,
                client_mutation_id = NULL,
                anonymous_ticket_hash = NULL,
                mutation_request_hash = NULL,
                mutation_expires_at_utc = NULL
            WHERE id = @CommentId;
            """,
            new SugarParameter("@CommentId", commentId));

    private static CommentCreateResult BuildCreateResult(
        Comment comment,
        bool idempotencyReplay = false,
        string? managementSecret = null)
        => new(
            true,
            comment.Id,
            comment.RootId ?? comment.Id,
            comment.ParentId,
            DateTime.SpecifyKind(comment.CreateTime, DateTimeKind.Utc),
            comment.ModerationStatus,
            comment.ModerationStatus switch
            {
                CommentModerationStatus.Approved => "public",
                CommentModerationStatus.Rejected => "rejected",
                CommentModerationStatus.Hidden => "hidden",
                _ => "pending"
            },
            comment.ModerationStatus == CommentModerationStatus.Approved,
            idempotencyReplay,
            FailureCode: null,
            ManagementSecret: managementSecret);

    private static string ComputeContentSha256(string content)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

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

        return DeleteCommentInternalAsync(id, currentUserId: 0, isAdmin: true, reason, actor.AdminPrincipalId);
    }

    public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
        => DeleteCommentInternalAsync(id, currentUserId, isAdmin, reason, actorAdminPrincipalId: null);

    private async Task<bool> DeleteCommentInternalAsync(
        long id,
        int currentUserId,
        bool isAdmin,
        string reason,
        long? actorAdminPrincipalId)
    {
        DateTime deletedAt = _clock.GetUtcNow().UtcDateTime;
        string? normalizedReason = TextHelpers.NormalizeNullable(reason, 256);
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
            if (deleted && mutationOutbox is not null)
            {
                await db.Insertable(new CommentModerationEvent
                {
                    CommentId = row.Id,
                    EventType = CommentModerationEventTypes.Delete,
                    PreviousStatus = row.ModerationStatus,
                    NextStatus = CommentModerationStatus.Hidden,
                    ActorType = actorAdminPrincipalId is > 0 ? "admin" : "account",
                    ReasonCode = normalizedReason,
                    TransitionSource = actorAdminPrincipalId is > 0 ? "admin" : "account",
                    AdminPrincipalId = actorAdminPrincipalId > 0 ? actorAdminPrincipalId : null,
                    OccurredAtUtc = deletedAt
                }).ExecuteCommandAsync();
                await mutationOutbox.EnqueueAsync(new CommentMutationOutboxEvent
                {
                    EventType = CommentMutationEventTypes.Deleted,
                    CommentId = row.Id,
                    ArticleId = row.ArticleId,
                    RootId = row.RootId ?? row.Id,
                    ParentId = row.ParentId,
                    AccountId = isAttributableUserComment ? row.UserId : null,
                    ActorAdminPrincipalId = actorAdminPrincipalId,
                    PreviousStatus = row.ModerationStatus,
                    NextStatus = CommentModerationStatus.Hidden,
                    OccurredAtUtc = deletedAt
                });
            }
        });
        if (!result.IsSuccess || row is null)
        {
            return false;
        }

        if (!deleted)
        {
            return false;
        }

        if (mutationOutbox is not null)
        {
            logger.LogInformation("评论软删除与 Outbox 已提交 | CommentId: {CommentId} | Article: {ArticleId}", id, row.ArticleId);
            return true;
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: row.ArticleId,
                RootId: row.RootId ?? row.Id,
                AccountId: isAttributableUserComment ? row.UserId : null,
                PublicArticleChanged: true,
                UserCommentsChanged: isAttributableUserComment));
        await commentNotifications.PublishRemovedAsync(row.ArticleId, id, row.RootId ?? id, row.ParentId);

        if (isAdmin && isAttributableUserComment && currentUserId != row.UserId!.Value)
        {
            string commentSnippet = row.Content.Length > 20 ? row.Content[..20] : row.Content;
            _ = commentNotifications.NotifyDeletionAsync(row.UserId.Value, row.ArticleTitle ?? "未知文章", commentSnippet, reason);
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
                   c.moderation_status,
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
            reader.ReadInt64("id"),
            reader.IsNull("user_id") ? null : reader.ReadInt32("user_id"),
            reader.ReadInt32("article_id"),
            reader.IsNull("parent_id") ? null : reader.ReadInt64("parent_id"),
            reader.IsNull("root_id") ? null : reader.ReadInt64("root_id"),
            reader.ReadString("content"),
            reader.ReadBoolean("is_deleted"),
            reader.ReadString("author_mode"),
            (CommentModerationStatus)reader.ReadInt32("moderation_status"),
            reader.IsNull("title") ? null : reader.ReadString("title"),
            reader.ReadString("row_version"));
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
        CommentModerationStatus ModerationStatus,
        string? ArticleTitle,
        string RowVersion);

    private static CommentMutationOutboxEvent BuildOutboxEvent(
        string eventType,
        Comment comment,
        long commentId,
        DateTime occurredAt,
        CommentModerationStatus? previousStatus,
        CommentModerationStatus? nextStatus)
        => new()
        {
            EventType = eventType,
            CommentId = commentId,
            ArticleId = comment.ArticleId,
            RootId = comment.RootId ?? commentId,
            ParentId = comment.ParentId,
            AccountId = comment.UserId,
            ReplyToAccountId = comment.ReplyToUserId,
            PreviousStatus = previousStatus,
            NextStatus = nextStatus,
            OccurredAtUtc = occurredAt
        };

    private static string NormalizeCommentContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        return TextHelpers.TrimOrEmpty(content);
    }

    private static bool IsAttributableUserComment(string? authorMode, int? userId)
        => userId is > 0
            && string.Equals(authorMode, CommentAuthorModes.Public, StringComparison.Ordinal);


}
