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

public partial class CommentService(
    ISqlSugarClient db,
    ILogger<CommentService> logger,
    ICommentNotificationService commentNotifications,
    ICommentModerationService commentModeration,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    ICommentActorResolver? commentActorResolver = null,
    IAnonymousCommentPolicyService? anonymousCommentPolicyService = null,
    ICommentAnonymousNullifierService? anonymousNullifierService = null,
    ISecurityRiskSignalSink? securityRiskSignalSink = null,
    IHttpContextAccessor? httpContextAccessor = null,
    IAnonymousCommentTicketService? anonymousCommentTicketService = null,
    ICommentAnonymousDisplayNameGenerator? anonymousDisplayNameGenerator = null,
    IConfiguration? configuration = null,
    IZkAnonymousProofService? zkAnonymousProofService = null) : ICommentEndpointService, ICommentCommandService
{
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
        AnonymousCommentPolicySnapshot policySnapshot = await ResolveCommentPolicyAsync(CancellationToken.None);
        if (!IsCommentContentWithinLimit(normalizedContent, policySnapshot))
        {
            return false;
        }

        RegionModerationDecision regionDecision = commentModeration.ResolveSubmissionRegion(
            normalizedContent,
            dto.ArticleId,
            userId,
            dto.RegionDecision);
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
        if (anonymousCommentPolicyService is null ||
            zkAnonymousProofService is null ||
            !IsZkSubmissionReady(zkAnonymousProofService.CurrentZkProdPolicy))
        {
            return false;
        }

        AnonymousCommentPolicySnapshot policySnapshot = await anonymousCommentPolicyService.GetCurrentAsync(cancellationToken);
        if (!policySnapshot.AnonymousCommentsEnabled ||
            !policySnapshot.ZkAnonymousEnabled ||
            !IsCommentContentWithinLimit(normalizedContent, policySnapshot))
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

        RegionModerationDecision effectiveRegionDecision = commentModeration.ResolveSubmissionRegion(
            normalizedContent,
            request.ArticleId,
            0,
            regionDecision);
        if (!effectiveRegionDecision.CanPublish)
        {
            return false;
        }

        AnonymousCommentPolicySnapshot currentPolicy = await anonymousCommentPolicyService.GetCurrentAsync(cancellationToken);
        if (!currentPolicy.AnonymousCommentsEnabled ||
            !currentPolicy.ZkAnonymousEnabled ||
            !IsZkSubmissionReady(zkAnonymousProofService.CurrentZkProdPolicy))
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

            ReplyTargetRow? parent = await LoadVisibleReplyTargetAsync(parsedParentId, articleId, cancellationToken);
            if (parent is null)
            {
                return false;
            }

            parentId = parent.Id;
            rootId = parent.RootId ?? parent.Id;
            if (requestedRootId.HasValue && requestedRootId.Value != rootId.Value)
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
            CredentialLevel = null,
            ReputationBucket = null,
            AccountAgeBucket = null,
            AnonymousRateClass = actor.RateClass,
            AnonymousRequiresModeration = actor.RequiresModeration,
            CreateTime = DateTime.UtcNow,
            ParentId = parentId,
            RootId = rootId,
            ReplyToUserId = replyToUserId,
            ReplyToCommentId = replyToCommentId,
            Depth = depth,
            IsDeleted = false,
            DeleteReason = null,
            DeleteTime = null,
            ModerationStatus = CommentModerationStatus.Approved,
            ModerationReason = BuildInitialModerationReason(regionDecision)
        };

        long generatedId = 0;
        var insertResult = await db.Ado.UseTranAsync(async () =>
        {
            if (!await LockVisibleCommentTargetAsync(articleId, parentId, rootId, now, cancellationToken))
            {
                throw new CommentTargetNotVisibleException();
            }

            generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
            if (generatedId <= 0)
            {
                throw new InvalidOperationException("Failed to create comment id.");
            }

            await commentModeration.PersistVisibilityAsync(generatedId, regionDecision, cancellationToken);

            if (enforceAnonymousNullifier)
            {
                NullifierReservationResult consume = await anonymousNullifierService!.TryConsumeAsync(
                    actor.AnonymousNullifierHash!,
                    actor.AnonymousScope!,
                    generatedId,
                    cancellationToken);
                if (!consume.Allowed)
                {
                    throw new AnonymousNullifierRejectedException(consume.Status, consume.Message);
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

        return true;
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

    private static bool RequiresAnonymousNullifierEnforcement(CommentActor actor)
        => !string.IsNullOrWhiteSpace(actor.AnonymousNullifierHash)
            && !string.IsNullOrWhiteSpace(actor.AnonymousScope)
            && string.Equals(actor.AuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal);

    private static bool IsZkSubmissionReady(ZkProdPolicySnapshot policy)
        => policy.Enabled &&
            policy.NativeVerifierConfigured &&
            policy.TrustedSetupVerified &&
            policy.CredentialRequired &&
            policy.CredentialRootReady &&
            string.IsNullOrWhiteSpace(policy.UnavailableReason);

    private static string HashAnonymousScopeForLog(string? scope)
    {
        string normalized = TextHelpers.TrimOrNull(scope) ?? "unknown";
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
            RateClass: ticket.RateClass,
            RequiresModeration: ticket.RequiresModeration);
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
            && ticket.ExpiresAtUnixMs > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            && string.Equals(ticket.Scope, NormalizeAnonymousScope(request.AnonymousScope, request.ArticleId), StringComparison.Ordinal)
            && ticket.ParentId == parentId
            && ticket.RootId == rootId
            && ticket.ReplyToCommentId == replyToCommentId;
    }

    private static string NormalizeAnonymousScope(string? value, int articleId)
    {
        string normalized = TextHelpers.TrimOrEmpty(value);
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
            $"nullifier:{TextHelpers.NormalizeNullable(status, 64) ?? "rejected"};scope:{TextHelpers.NormalizeNullable(scope, 64) ?? "unknown"}"), cancellationToken);
    }

    private static string ResolveCommentRiskAction(HttpContext httpContext)
        => httpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] is RiskActionEndpointMetadata metadata
            ? metadata.ActionName
            : RiskActionNames.CommentCreate;

    private static string BuildInitialModerationReason(RegionModerationDecision decision)
    {
        if (decision.DecisionReason.Contains("risk_control_queue", StringComparison.Ordinal))
        {
            return TextHelpers.NormalizeNullable($"published_{decision.DecisionReason}", 256) ?? "published_risk_control_queue";
        }

        if (decision.HideUntilReviewed)
        {
            return "published_region_manual_review_no_public_display";
        }

        if (decision.RequiresManualReview)
        {
            return "published_region_manual_review";
        }

        return "published_pending_review";
    }

    private sealed class AnonymousNullifierRejectedException(string status, string message) : Exception(message)
    {
        public string Status { get; } = status;
    }

    private sealed class CommentTargetNotVisibleException : Exception
    {
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
        string? ArticleTitle,
        string RowVersion);

    private static string NormalizeCommentContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        return TextHelpers.TrimOrEmpty(content);
    }

    private async Task<AnonymousCommentPolicySnapshot> ResolveCommentPolicyAsync(CancellationToken cancellationToken)
        => anonymousCommentPolicyService is null
            ? AnonymousCommentPolicySnapshot.Default
            : await anonymousCommentPolicyService.GetCurrentAsync(cancellationToken);

    private static bool IsCommentContentWithinLimit(string content, AnonymousCommentPolicySnapshot policy)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;

    private static bool IsAttributableUserComment(string? authorMode, int? userId)
        => userId is > 0
            && string.Equals(authorMode, CommentAuthorModes.Public, StringComparison.Ordinal);


}
