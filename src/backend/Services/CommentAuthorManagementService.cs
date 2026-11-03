using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.WebUtilities;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed record CommentEditRequest(int ExpectedVersion, string Content, string Challenge);

public sealed record CommentAppealRequest(string Reason, string Challenge);

public sealed record CommentManagementChallengeRequest(string Purpose, string? CapabilitySecret = null);

public sealed record AnonymousCommentEditRequest(
    int ExpectedVersion,
    string Content,
    string Challenge,
    string CapabilitySecret);

public sealed record AnonymousCommentActionRequest(string Challenge, string CapabilitySecret);

public sealed record AnonymousCommentAppealRequest(string Reason, string Challenge, string CapabilitySecret);

public sealed record AnonymousCommentCreateResponse(
    long CommentId,
    long RootId,
    long? ParentId,
    DateTime CreatedAtUtc,
    int ModerationStatus,
    string VisibilityState,
    bool IsPubliclyVisible,
    bool IdempotencyReplay,
    string ManagementSecret);

public sealed record CommentAuthorMutationResult(
    bool Success,
    string Code,
    int CurrentVersion,
    CommentModerationStatus ModerationStatus,
    DateTime? EditedAtUtc = null);

public sealed record CommentAuthorStatusResult(
    bool Found,
    int CurrentVersion,
    CommentModerationStatus ModerationStatus,
    string? ModerationReason,
    bool IsDeleted,
    DateTime? EditedAtUtc);

public sealed record CommentRevisionResult(
    int Version,
    string Content,
    string ContentSha256,
    string Operation,
    DateTime CreatedAtUtc,
    string ActorMode);

public interface ICommentAuthorManagementService
{
    Task<CommentManagementChallengeResult> IssueAccountChallengeAsync(
        long commentId,
        int accountId,
        string purpose,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> EditAsAccountAsync(
        long commentId,
        int accountId,
        CommentEditRequest request,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> EditAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        CommentEditRequest request,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> DeleteAsAccountAsync(
        long commentId,
        int accountId,
        string challenge,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> DeleteAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        string challenge,
        CancellationToken cancellationToken);

    Task<CommentAuthorStatusResult> ReadAnonymousStatusAsync(
        long commentId,
        string capabilitySecret,
        string challenge,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> AppealAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        CommentAppealRequest request,
        CancellationToken cancellationToken);

    Task<CommentAuthorMutationResult> AppealAsAccountAsync(
        long commentId,
        int accountId,
        CommentAppealRequest request,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<CommentRevisionResult>> ReadRevisionsAsAdminAsync(
        long commentId,
        CancellationToken cancellationToken);
}

public sealed class CommentAuthorManagementService(
    ISqlSugarClient db,
    ICommentManagementCapabilityService capabilities,
    ICommentModerationService moderation,
    IContentFilterService contentFilter,
    ICommentMutationOutbox mutationOutbox,
    IConfiguration configuration,
    TimeProvider timeProvider,
    ICommentGovernanceService? governance = null) : ICommentAuthorManagementService
{
    private const int DefaultEditWindowMinutes = 30;

    public async Task<CommentManagementChallengeResult> IssueAccountChallengeAsync(
        long commentId,
        int accountId,
        string purpose,
        CancellationToken cancellationToken)
    {
        if (commentId <= 0 || accountId <= 0 || !CommentManagementPurposes.IsKnown(purpose))
        {
            return CommentManagementChallengeResult.Failed("comment_management_request_invalid");
        }

        Comment? comment = await db.Queryable<Comment>()
            .Where(comment => comment.Id == commentId
                && comment.UserId == accountId
                && !comment.IsDeleted)
            .FirstAsync(cancellationToken);
        if (comment is null)
        {
            return CommentManagementChallengeResult.Failed("comment_management_not_found");
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        DateTime expiresAt = now.Add(CommentManagementCapabilityService.ChallengeLifetime);
        string challenge = WebEncoders.Base64UrlEncode(
            RandomNumberGenerator.GetBytes(CommentManagementCapabilityService.SecretBytes));
        await db.Insertable(new CommentManagementChallenge
        {
            ChallengeHash = CommentManagementCapabilityService.ComputeCommitment(challenge),
            CommentId = commentId,
            Purpose = purpose,
            ExpiresAtUtc = expiresAt
        }).ExecuteCommandAsync(cancellationToken);
        return new CommentManagementChallengeResult(true, challenge, expiresAt, null, comment.CurrentVersion);
    }

    public Task<CommentAuthorMutationResult> EditAsAccountAsync(
        long commentId,
        int accountId,
        CommentEditRequest request,
        CancellationToken cancellationToken)
        => EditAsync(commentId, request, accountId, capabilitySecret: null, cancellationToken);

    public Task<CommentAuthorMutationResult> EditAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        CommentEditRequest request,
        CancellationToken cancellationToken)
        => EditAsync(commentId, request, accountId: null, capabilitySecret, cancellationToken);

    public async Task<CommentAuthorMutationResult> DeleteAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        string challenge,
        CancellationToken cancellationToken)
    {
        Comment? comment = await LoadAnonymousCommentAsync(commentId, capabilitySecret, cancellationToken);
        if (comment is null)
        {
            return Failed("comment_management_capability_invalid");
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        int affected = 0;
        bool versionConflict = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            if (!await capabilities.ConsumeChallengeAsync(
                    commentId,
                    challenge,
                    CommentManagementPurposes.Delete,
                    cancellationToken))
            {
                return;
            }

            affected = await db.Updateable<Comment>()
                .SetColumns(item => item.IsDeleted == true)
                .SetColumns(item => item.DeleteReason == "author_deleted")
                .SetColumns(item => item.DeleteTime == now)
                .SetColumns(item => item.CurrentVersion == comment.CurrentVersion + 1)
                .Where(item => item.Id == commentId
                    && !item.IsDeleted
                    && item.CurrentVersion == comment.CurrentVersion)
                .ExecuteCommandAsync(cancellationToken);
            if (affected != 1)
            {
                versionConflict = true;
                throw new CommentMutationConcurrencyException();
            }

            await InsertRevisionAsync(comment, comment.CurrentVersion + 1, CommentRevisionOperations.Deleted, now, null, cancellationToken);
            await db.Insertable(new CommentModerationEvent
            {
                CommentId = comment.Id,
                EventType = CommentModerationEventTypes.Delete,
                PreviousStatus = comment.ModerationStatus,
                NextStatus = comment.ModerationStatus,
                ActorType = "anonymous",
                ReasonCode = "author_deleted",
                TransitionSource = "anonymous",
                OccurredAtUtc = now
            }).ExecuteCommandAsync(cancellationToken);
            await mutationOutbox.EnqueueAsync(BuildOutbox(
                CommentMutationEventTypes.Deleted,
                comment,
                now,
                comment.ModerationStatus,
                comment.ModerationStatus), cancellationToken);
        });

        return transaction.IsSuccess && affected == 1
            ? new CommentAuthorMutationResult(true, "ok", comment.CurrentVersion + 1, comment.ModerationStatus, comment.EditedAtUtc)
            : Failed(versionConflict ? "comment_version_conflict" : "comment_management_challenge_invalid");
    }

    public async Task<CommentAuthorMutationResult> DeleteAsAccountAsync(
        long commentId,
        int accountId,
        string challenge,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>()
            .Where(item => item.Id == commentId && item.UserId == accountId && !item.IsDeleted)
            .FirstAsync(cancellationToken);
        if (comment is null)
        {
            return Failed("comment_management_not_found");
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        int affected = 0;
        bool versionConflict = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            if (!await capabilities.ConsumeChallengeAsync(
                    commentId,
                    challenge,
                    CommentManagementPurposes.Delete,
                    cancellationToken))
            {
                return;
            }

            affected = await db.Updateable<Comment>()
                .SetColumns(item => item.IsDeleted == true)
                .SetColumns(item => item.DeleteReason == "author_deleted")
                .SetColumns(item => item.DeleteTime == now)
                .SetColumns(item => item.CurrentVersion == comment.CurrentVersion + 1)
                .Where(item => item.Id == commentId
                    && item.UserId == accountId
                    && !item.IsDeleted
                    && item.CurrentVersion == comment.CurrentVersion)
                .ExecuteCommandAsync(cancellationToken);
            if (affected != 1)
            {
                versionConflict = true;
                throw new CommentMutationConcurrencyException();
            }

            await InsertRevisionAsync(
                comment,
                comment.CurrentVersion + 1,
                CommentRevisionOperations.Deleted,
                now,
                accountId,
                cancellationToken);
            await db.Insertable(new CommentModerationEvent
            {
                CommentId = comment.Id,
                EventType = CommentModerationEventTypes.Delete,
                PreviousStatus = comment.ModerationStatus,
                NextStatus = comment.ModerationStatus,
                ActorType = "account",
                ReasonCode = "author_deleted",
                TransitionSource = "account",
                OccurredAtUtc = now
            }).ExecuteCommandAsync(cancellationToken);
            await mutationOutbox.EnqueueAsync(BuildOutbox(
                CommentMutationEventTypes.Deleted,
                comment,
                now,
                comment.ModerationStatus,
                comment.ModerationStatus), cancellationToken);
        });

        return transaction.IsSuccess && affected == 1
            ? new CommentAuthorMutationResult(true, "ok", comment.CurrentVersion + 1, comment.ModerationStatus, comment.EditedAtUtc)
            : Failed(versionConflict ? "comment_version_conflict" : "comment_management_challenge_invalid");
    }

    public async Task<CommentAuthorStatusResult> ReadAnonymousStatusAsync(
        long commentId,
        string capabilitySecret,
        string challenge,
        CancellationToken cancellationToken)
    {
        Comment? comment = await LoadAnonymousCommentAsync(commentId, capabilitySecret, cancellationToken);
        if (comment is null
            || !await capabilities.ConsumeChallengeAsync(
                commentId,
                challenge,
                CommentManagementPurposes.Status,
                cancellationToken))
        {
            return new CommentAuthorStatusResult(false, 0, CommentModerationStatus.Pending, null, false, null);
        }

        return new CommentAuthorStatusResult(
            true,
            comment.CurrentVersion,
            comment.ModerationStatus,
            comment.ModerationReason,
            comment.IsDeleted,
            comment.EditedAtUtc);
    }

    public async Task<CommentAuthorMutationResult> AppealAsAnonymousAsync(
        long commentId,
        string capabilitySecret,
        CommentAppealRequest request,
        CancellationToken cancellationToken)
    {
        if (governance is not null)
        {
            CommentAppealResult governed = await governance.AppealAsAnonymousAsync(
                commentId, capabilitySecret, request, cancellationToken);
            return governed.Success
                ? new CommentAuthorMutationResult(true, "ok", 0, CommentModerationStatus.Pending)
                : Failed(governed.Code);
        }

        Comment? comment = await LoadAnonymousCommentAsync(commentId, capabilitySecret, cancellationToken);
        string reason = (request.Reason ?? string.Empty).Trim();
        if (comment is null || reason.Length is < 10 or > 1000)
        {
            return Failed(comment is null ? "comment_management_capability_invalid" : "comment_appeal_reason_invalid");
        }

        bool inserted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            if (!await capabilities.ConsumeChallengeAsync(
                    commentId,
                    request.Challenge,
                    CommentManagementPurposes.Appeal,
                    cancellationToken))
            {
                return;
            }

            await db.Insertable(new CommentAuthorAppeal
            {
                CommentId = commentId,
                Reason = reason,
                CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime,
                AuthorMode = comment.AuthorMode,
                AccountId = null,
                Status = "pending"
            }).ExecuteCommandAsync(cancellationToken);
            inserted = true;
        });
        return transaction.IsSuccess && inserted
            ? new CommentAuthorMutationResult(true, "ok", comment.CurrentVersion, comment.ModerationStatus, comment.EditedAtUtc)
            : Failed("comment_management_challenge_invalid");
    }

    public async Task<CommentAuthorMutationResult> AppealAsAccountAsync(
        long commentId,
        int accountId,
        CommentAppealRequest request,
        CancellationToken cancellationToken)
    {
        if (governance is null)
        {
            return Failed("comment_appeal_unavailable");
        }
        CommentAppealResult result = await governance.AppealAsAccountAsync(commentId, accountId, request, cancellationToken);
        return result.Success
            ? new CommentAuthorMutationResult(true, "ok", 0, CommentModerationStatus.Pending)
            : Failed(result.Code);
    }

    public async Task<IReadOnlyList<CommentRevisionResult>> ReadRevisionsAsAdminAsync(
        long commentId,
        CancellationToken cancellationToken)
    {
        List<CommentRevision> revisions = await db.Queryable<CommentRevision>()
            .Where(item => item.CommentId == commentId)
            .OrderBy(item => item.Version, OrderByType.Desc)
            .ToListAsync(cancellationToken);
        return revisions.Select(static item => new CommentRevisionResult(
            item.Version,
            item.Content,
            item.ContentSha256,
            item.Operation,
            item.CreatedAtUtc,
            item.ActorMode)).ToArray();
    }

    private async Task<CommentAuthorMutationResult> EditAsync(
        long commentId,
        CommentEditRequest request,
        int? accountId,
        string? capabilitySecret,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>()
            .Where(item => item.Id == commentId && !item.IsDeleted)
            .FirstAsync(cancellationToken);
        if (comment is null || !IsAuthorized(comment, accountId, capabilitySecret))
        {
            return Failed("comment_management_not_found");
        }
        if (request.ExpectedVersion != comment.CurrentVersion)
        {
            return new CommentAuthorMutationResult(
                false,
                "comment_version_conflict",
                comment.CurrentVersion,
                comment.ModerationStatus,
                comment.EditedAtUtc);
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        int editWindowMinutes = Math.Clamp(
            configuration.GetValue("Comments:AuthorEditWindowMinutes", DefaultEditWindowMinutes),
            1,
            24 * 60);
        if (comment.CreateTime.AddMinutes(editWindowMinutes) < now)
        {
            return Failed("comment_edit_window_closed");
        }

        string content = NormalizeContent(request.Content);
        if (content.Length == 0
            || content.Length > CommentLimits.HardContentMaxChars
            || Encoding.UTF8.GetByteCount(content) > CommentLimits.HardContentMaxUtf8Bytes)
        {
            return Failed("comment_content_invalid");
        }
        CommentMarkdownPolicyResult markdown = CommentMarkdownPolicy.ValidateForSubmit(content);
        if (!markdown.IsValid)
        {
            return Failed(markdown.ReasonCode);
        }
        if (!contentFilter.ValidateContent(markdown.ReviewText).IsValid)
        {
            return Failed("comment_content_filtered");
        }

        RegionModerationDecision region = moderation.ResolveSubmissionRegion(
            markdown.ReviewText,
            comment.ArticleId,
            comment.UserId ?? 0,
            suppliedDecision: null);
        if (!region.CanPublish)
        {
            return Failed("comment_region_blocked");
        }

        CommentActor actor = BuildActor(comment);
        CommentInitialModerationDecision next = moderation.ResolveInitialState(actor, region);
        int nextVersion = comment.CurrentVersion + 1;
        int affected = 0;
        bool versionConflict = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            if (!await capabilities.ConsumeChallengeAsync(
                    commentId,
                    request.Challenge,
                    CommentManagementPurposes.Edit,
                    cancellationToken))
            {
                return;
            }

            affected = await db.Updateable<Comment>()
                .SetColumns(item => item.Content == content)
                .SetColumns(item => item.CurrentVersion == nextVersion)
                .SetColumns(item => item.EditedAtUtc == now)
                .SetColumns(item => item.ModerationStatus == next.Status)
                .SetColumns(item => item.ModerationReason == next.ReasonCode)
                .SetColumns(item => item.ModeratedByAdminPrincipalId == null)
                .SetColumns(item => item.ModeratedAt == now)
                .Where(item => item.Id == commentId
                    && !item.IsDeleted
                    && item.CurrentVersion == request.ExpectedVersion)
                .ExecuteCommandAsync(cancellationToken);
            if (affected != 1)
            {
                versionConflict = true;
                throw new CommentMutationConcurrencyException();
            }

            await db.Insertable(CommentCommandService.BuildRevision(
                commentId,
                nextVersion,
                CommentRevisionOperations.Edited,
                content,
                now,
                comment.AuthorMode,
                accountId,
                null)).ExecuteCommandAsync(cancellationToken);
            if (next.Status != comment.ModerationStatus)
            {
                await db.Insertable(new CommentModerationEvent
                {
                    CommentId = commentId,
                    EventType = next.Status switch
                    {
                        CommentModerationStatus.Approved => CommentModerationEventTypes.Approve,
                        CommentModerationStatus.Rejected => CommentModerationEventTypes.Reject,
                        CommentModerationStatus.Hidden => CommentModerationEventTypes.Hide,
                        _ => CommentModerationEventTypes.Pending
                    },
                    PreviousStatus = comment.ModerationStatus,
                    NextStatus = next.Status,
                    ActorType = accountId.HasValue ? "account" : "anonymous",
                    ReasonCode = next.ReasonCode,
                    TransitionSource = "edit",
                    OccurredAtUtc = now
                }).ExecuteCommandAsync(cancellationToken);
            }
            await moderation.PersistVisibilityAsync(commentId, region, cancellationToken);
            await mutationOutbox.EnqueueAsync(BuildOutbox(
                CommentMutationEventTypes.Edited,
                comment,
                now,
                comment.ModerationStatus,
                next.Status), cancellationToken);
        });

        if (!transaction.IsSuccess || affected != 1)
        {
            return new CommentAuthorMutationResult(
                false,
                versionConflict ? "comment_version_conflict" : "comment_management_challenge_invalid",
                comment.CurrentVersion,
                comment.ModerationStatus,
                comment.EditedAtUtc);
        }

        comment.Content = content;
        comment.CurrentVersion = nextVersion;
        comment.EditedAtUtc = now;
        comment.ModerationStatus = next.Status;
        comment.ModerationReason = next.ReasonCode;
        await moderation.ApplyPostInsertAsync(
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
            region,
            cancellationToken);

        return new CommentAuthorMutationResult(true, "ok", nextVersion, comment.ModerationStatus, now);
    }

    private bool IsAuthorized(Comment comment, int? accountId, string? capabilitySecret)
        => accountId is > 0
            ? comment.UserId == accountId && comment.ManagementCapabilityHash is null
            : comment.UserId is null
                && comment.ManagementCapabilityHash is not null
                && capabilities.VerifyCapability(capabilitySecret ?? string.Empty, comment.ManagementCapabilityHash);

    private async Task<Comment?> LoadAnonymousCommentAsync(
        long commentId,
        string capabilitySecret,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>()
            .Where(item => item.Id == commentId
                && item.UserId == null
                && item.ManagementCapabilityHash != null)
            .FirstAsync(cancellationToken);
        return comment is not null
            && capabilities.VerifyCapability(capabilitySecret, comment.ManagementCapabilityHash!)
                ? comment
                : null;
    }

    private static CommentActor BuildActor(Comment comment)
        => new(
            comment.UserId,
            comment.AuthorMode,
            comment.PublicHandle,
            comment.AnonymousHandle,
            comment.AnonymousDisplayName ?? comment.PublicHandle ?? "comment-author",
            comment.AnonymousDisplayLanguage ?? "und",
            comment.AnonymousNullifierHash,
            comment.AnonymousScope,
            comment.ModerationSubjectHash ?? string.Empty,
            comment.AnonymousRateClass ?? "standard",
            comment.AnonymousRequiresModeration == true);

    private Task InsertRevisionAsync(
        Comment comment,
        int version,
        string operation,
        DateTime now,
        int? actorAccountId,
        CancellationToken cancellationToken)
        => db.Insertable(CommentCommandService.BuildRevision(
            comment.Id,
            version,
            operation,
            comment.Content,
            now,
            comment.AuthorMode,
            actorAccountId,
            null)).ExecuteCommandAsync(cancellationToken);

    private CommentMutationOutboxEvent BuildOutbox(
        string eventType,
        Comment comment,
        DateTime occurredAt,
        CommentModerationStatus? previousStatus,
        CommentModerationStatus? nextStatus)
        => new()
        {
            EventType = eventType,
            CommentId = comment.Id,
            ArticleId = comment.ArticleId,
            RootId = comment.RootId ?? comment.Id,
            ParentId = comment.ParentId,
            AccountId = comment.UserId,
            ReplyToAccountId = comment.ReplyToUserId,
            PreviousStatus = previousStatus,
            NextStatus = nextStatus,
            OccurredAtUtc = occurredAt
        };

    private static CommentAuthorMutationResult Failed(string code)
        => new(false, code, 0, CommentModerationStatus.Pending);

    private static string NormalizeContent(string? value)
        => (value ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Trim();

    private sealed class CommentMutationConcurrencyException : Exception;
}
