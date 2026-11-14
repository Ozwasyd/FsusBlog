using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed record CommentReportRequest(string ReasonCode, string? Detail, string? ScopedCredential = null);
public sealed record CommentReportResult(bool Success, string Code, long? ReportId, bool Duplicate);
public sealed record CommentAppealDecisionRequest(string Decision, string Reason);
public sealed record CommentAppealResult(bool Success, string Code, long? AppealId);
public sealed record CommentModerationTimelineResult(long CommentId, CommentModerationStatus ProjectedStatus, CommentModerationStatus CurrentStatus, bool Consistent, IReadOnlyList<CommentModerationEvent> Events);

public interface ICommentGovernanceService
{
    Task<CommentReportResult> ReportAsAccountAsync(long commentId, int accountId, CommentReportRequest request, CancellationToken cancellationToken);
    Task<CommentReportResult> ReportAsScopedAnonymousAsync(long commentId, CommentReportRequest request, CancellationToken cancellationToken);
    Task<CommentAppealResult> AppealAsAccountAsync(long commentId, int accountId, CommentAppealRequest request, CancellationToken cancellationToken);
    Task<CommentAppealResult> AppealAsAnonymousAsync(long commentId, string capabilitySecret, CommentAppealRequest request, CancellationToken cancellationToken);
    Task<CommentAppealResult> ReviewAppealAsync(long appealId, long reviewerAdminPrincipalId, CommentAppealDecisionRequest request, CancellationToken cancellationToken);
    Task<CommentModerationTimelineResult?> ReadTimelineAsync(long commentId, CancellationToken cancellationToken);
}

public sealed class CommentGovernanceService(
    ISqlSugarClient db,
    ICommentManagementCapabilityService capabilities,
    IAuditEventService auditEvents,
    IConfiguration configuration,
    TimeProvider timeProvider) : ICommentGovernanceService
{
    private readonly byte[] _reportPepper = ResolveReportPepper(configuration);

    public Task<CommentReportResult> ReportAsAccountAsync(long commentId, int accountId, CommentReportRequest request, CancellationToken cancellationToken)
        => ReportAsync(commentId, request, accountId, null, cancellationToken);

    public Task<CommentReportResult> ReportAsScopedAnonymousAsync(long commentId, CommentReportRequest request, CancellationToken cancellationToken)
    {
        string credential = request.ScopedCredential?.Trim() ?? string.Empty;
        if (credential.Length is < 32 or > 512)
        {
            return Task.FromResult(new CommentReportResult(false, "comment_report_credential_invalid", null, false));
        }
        string scopeHash = Convert.ToHexStringLower(HMACSHA256.HashData(
            _reportPepper,
            Encoding.UTF8.GetBytes($"comment-report:v1:{commentId}:{credential}")));
        return ReportAsync(commentId, request, null, scopeHash, cancellationToken);
    }

    public async Task<CommentAppealResult> AppealAsAccountAsync(long commentId, int accountId, CommentAppealRequest request, CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>()
            .Where(item => item.Id == commentId && item.UserId == accountId && !item.IsDeleted)
            .FirstAsync(cancellationToken);
        return comment is null
            ? new(false, "comment_management_not_found", null)
            : await AppealAsync(comment, request, accountId, cancellationToken);
    }

    public async Task<CommentAppealResult> AppealAsAnonymousAsync(long commentId, string capabilitySecret, CommentAppealRequest request, CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().Where(item => item.Id == commentId && !item.IsDeleted).FirstAsync(cancellationToken);
        string suppliedHash = CommentManagementCapabilityService.ComputeCommitment(capabilitySecret);
        if (comment?.ManagementCapabilityHash is not { Length: 64 } storedHash
            || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(storedHash), Convert.FromHexString(suppliedHash)))
        {
            return new(false, "comment_management_capability_invalid", null);
        }
        return await AppealAsync(comment, request, null, cancellationToken);
    }

    public async Task<CommentAppealResult> ReviewAppealAsync(long appealId, long reviewerAdminPrincipalId, CommentAppealDecisionRequest request, CancellationToken cancellationToken)
    {
        string decision = request.Decision?.Trim().ToLowerInvariant() ?? string.Empty;
        string reason = request.Reason?.Trim() ?? string.Empty;
        if (appealId <= 0 || reviewerAdminPrincipalId <= 0 || decision is not ("granted" or "denied") || reason.Length is < 10 or > 1000)
        {
            return new(false, "comment_appeal_decision_invalid", null);
        }
        CommentAuthorAppeal? appeal = await db.Queryable<CommentAuthorAppeal>()
            .Where(item => item.Id == appealId && item.Status == "pending")
            .FirstAsync(cancellationToken);
        if (appeal is null)
        {
            return new(false, "comment_appeal_not_found", null);
        }
        CommentModerationEvent? target = appeal.TargetModerationEventId is > 0
            ? await db.Queryable<CommentModerationEvent>().InSingleAsync(appeal.TargetModerationEventId.Value)
            : null;
        if (configuration.GetValue("Moderation:Appeals:RequireDifferentReviewer", true)
            && target?.AdminPrincipalId == reviewerAdminPrincipalId)
        {
            return new(false, "comment_appeal_reviewer_conflict", null);
        }
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(appeal.CommentId);
        if (comment is null)
        {
            return new(false, "comment_not_found", null);
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        bool completed = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            int updated = await db.Updateable<CommentAuthorAppeal>()
                .SetColumns(item => item.Status == "decided")
                .SetColumns(item => item.ReviewerAdminPrincipalId == reviewerAdminPrincipalId)
                .SetColumns(item => item.Decision == decision)
                .SetColumns(item => item.DecisionReason == reason)
                .SetColumns(item => item.DecidedAtUtc == now)
                .Where(item => item.Id == appealId && item.Status == "pending")
                .ExecuteCommandAsync(cancellationToken);
            if (updated != 1)
            {
                return;
            }
            CommentModerationStatus previous = comment.ModerationStatus;
            CommentModerationStatus resulting = previous;
            if (decision == "granted" && comment.ModerationStatus is CommentModerationStatus.Hidden or CommentModerationStatus.Rejected)
            {
                resulting = CommentModerationStatus.Approved;
                await db.Updateable<Comment>()
                    .SetColumns(item => item.ModerationStatus == resulting)
                    .SetColumns(item => item.ModerationReason == "appeal_granted")
                    .SetColumns(item => item.ModeratedByAdminPrincipalId == reviewerAdminPrincipalId)
                    .SetColumns(item => item.ModeratedAt == now)
                    .Where(item => item.Id == comment.Id && item.ModerationStatus == comment.ModerationStatus)
                    .ExecuteCommandAsync(cancellationToken);
            }
            await db.Insertable(Event(comment.Id, CommentModerationEventTypes.AppealDecision, previous, resulting, "admin", $"appeal_{decision}", now, reviewerAdminPrincipalId, appealId))
                .ExecuteCommandAsync(cancellationToken);
            completed = true;
        });
        if (!transaction.IsSuccess || !completed)
        {
            return new(false, "comment_appeal_conflict", null);
        }
        await AuditAsync("admin.comment.appeal_decided", "admin", comment.Id, decision, cancellationToken);
        return new(true, "ok", appealId);
    }

    public async Task<CommentModerationTimelineResult?> ReadTimelineAsync(long commentId, CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(commentId);
        if (comment is null)
        {
            return null;
        }
        List<CommentModerationEvent> events = await db.Queryable<CommentModerationEvent>()
            .Where(item => item.CommentId == commentId)
            .OrderBy(item => item.OccurredAtUtc, OrderByType.Asc)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken);
        CommentModerationStatus projected = events.Count == 0 ? comment.ModerationStatus : events[0].NextStatus;
        bool consistent = events.Count > 0 && events[0].PreviousStatus is null;
        foreach (CommentModerationEvent item in events.Skip(1))
        {
            consistent &= item.PreviousStatus == projected;
            projected = item.NextStatus;
        }
        consistent &= projected == comment.ModerationStatus;
        return new(commentId, projected, comment.ModerationStatus, consistent, events);
    }

    private async Task<CommentReportResult> ReportAsync(long commentId, CommentReportRequest request, int? accountId, string? scopeHash, CancellationToken cancellationToken)
    {
        string reason = request.ReasonCode?.Trim().ToLowerInvariant() ?? string.Empty;
        string? detail = string.IsNullOrWhiteSpace(request.Detail) ? null : request.Detail.Trim();
        if (commentId <= 0 || (accountId ?? 1) <= 0 || !CommentReportReasons.IsAllowed(reason) || detail?.Length > 1000)
        {
            return new(false, "comment_report_invalid", null, false);
        }
        if (!await db.Queryable<Comment>().AnyAsync(item => item.Id == commentId && !item.IsDeleted, cancellationToken))
        {
            return new(false, "comment_not_found", null, false);
        }
        CommentReport? existing = await FindReportAsync(commentId, accountId, scopeHash, cancellationToken);
        if (existing is not null)
        {
            await AuditAsync("comment.report.duplicate", accountId.HasValue ? "account" : "anonymous", commentId, reason, cancellationToken);
            return new(true, "comment_report_duplicate", existing.Id, true);
        }
        var report = new CommentReport
        {
            CommentId = commentId,
            ReasonCode = reason,
            Detail = detail,
            ReporterKind = accountId.HasValue ? CommentReporterKinds.Account : CommentReporterKinds.ScopedAnonymous,
            ReporterAccountId = accountId,
            ReporterScopeHash = scopeHash,
            RiskScore = Score(reason, detail),
            Status = CommentReportStatuses.Open,
            CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime
        };
        try
        {
            report.Id = await db.Insertable(report).ExecuteReturnBigIdentityAsync(cancellationToken);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            existing = await FindReportAsync(commentId, accountId, scopeHash, cancellationToken);
            if (existing is null)
            {
                throw;
            }
            return new(true, "comment_report_duplicate", existing.Id, true);
        }
        await AuditAsync("comment.report.created", report.ReporterKind, commentId, reason, cancellationToken);
        return new(true, "ok", report.Id, false);
    }

    private async Task<CommentReport?> FindReportAsync(long commentId, int? accountId, string? scopeHash, CancellationToken cancellationToken)
        => accountId.HasValue
            ? await db.Queryable<CommentReport>().Where(item => item.CommentId == commentId && item.ReporterAccountId == accountId).FirstAsync(cancellationToken)
            : await db.Queryable<CommentReport>().Where(item => item.CommentId == commentId && item.ReporterScopeHash == scopeHash).FirstAsync(cancellationToken);

    private async Task<CommentAppealResult> AppealAsync(Comment comment, CommentAppealRequest request, int? accountId, CancellationToken cancellationToken)
    {
        string reason = request.Reason?.Trim() ?? string.Empty;
        if (reason.Length is < 10 or > 1000 || comment.ModerationStatus is not (CommentModerationStatus.Hidden or CommentModerationStatus.Rejected))
        {
            return new(false, "comment_appeal_not_allowed", null);
        }
        CommentModerationEvent? target = await db.Queryable<CommentModerationEvent>()
            .Where(item => item.CommentId == comment.Id && (item.EventType == CommentModerationEventTypes.Hide || item.EventType == CommentModerationEventTypes.Reject))
            .OrderBy(item => item.Id, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (target is null)
        {
            return new(false, "comment_appeal_decision_missing", null);
        }
        if (await db.Queryable<CommentAuthorAppeal>().AnyAsync(item => item.CommentId == comment.Id && item.TargetModerationEventId == target.Id, cancellationToken))
        {
            return new(false, "comment_appeal_limit_reached", null);
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        long appealId = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            if (!await capabilities.ConsumeChallengeAsync(comment.Id, request.Challenge, CommentManagementPurposes.Appeal, cancellationToken))
            {
                return;
            }
            appealId = await db.Insertable(new CommentAuthorAppeal
            {
                CommentId = comment.Id,
                Reason = reason,
                CreatedAtUtc = now,
                AuthorMode = comment.AuthorMode,
                AccountId = accountId,
                Status = "pending",
                TargetModerationEventId = target.Id
            }).ExecuteReturnBigIdentityAsync(cancellationToken);
            await db.Insertable(Event(comment.Id, CommentModerationEventTypes.Appeal, comment.ModerationStatus, comment.ModerationStatus,
                    accountId.HasValue ? "account_author" : "capability_author", "author_appeal_submitted", now, null, appealId))
                .ExecuteCommandAsync(cancellationToken);
        });
        if (!transaction.IsSuccess || appealId <= 0)
        {
            return new(false, "comment_management_challenge_invalid", null);
        }
        await AuditAsync("comment.appeal.submitted", accountId.HasValue ? "account" : "anonymous", comment.Id, "submitted", cancellationToken);
        return new(true, "ok", appealId);
    }

    private static CommentModerationEvent Event(long commentId, string type, CommentModerationStatus previous, CommentModerationStatus next, string actor, string reason, DateTime now, long? adminId, long? appealId)
        => new()
        {
            CommentId = commentId,
            EventType = type,
            PreviousStatus = previous,
            NextStatus = next,
            ActorType = actor,
            ReasonCode = reason,
            TransitionSource = actor,
            AdminPrincipalId = adminId,
            AppealId = appealId,
            OccurredAtUtc = now
        };

    private Task AuditAsync(string action, string actorType, long commentId, string reason, CancellationToken cancellationToken)
        => auditEvents.RecordAsync(new AuditEvent(AuditSourceCatalog.Security, AuditTypeCatalog.Security, action, AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Info, "评论治理动作", ActorType: actorType, TargetType: "comment",
            TargetId: commentId.ToString(System.Globalization.CultureInfo.InvariantCulture), ReasonCode: reason), cancellationToken);

    private static int Score(string reason, string? detail)
        => Math.Clamp((reason switch
        {
            "illegal" => 90,
            "privacy" => 80,
            "hate" => 70,
            "harassment" => 60,
            "spam" => 40,
            "misinformation" => 35,
            _ => 20
        }) + (detail is null ? 0 : 5), 0, 100);

    private static byte[] ResolveReportPepper(IConfiguration configuration)
    {
        string value = configuration["Moderation:ReportPepper"] ?? configuration["Moderation:Pepper"] ?? string.Empty;
        if (value.Length < 32)
        {
            throw new InvalidOperationException("Moderation:ReportPepper must be configured with at least 32 characters.");
        }
        return SHA256.HashData(Encoding.UTF8.GetBytes(value));
    }
}
