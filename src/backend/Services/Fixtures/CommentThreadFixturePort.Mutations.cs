using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Services.Fixtures;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "command")]
[JsonDerivedType(typeof(CommentFixtureEdit), "edit")]
[JsonDerivedType(typeof(CommentFixtureSoftDelete), "soft-delete")]
[JsonDerivedType(typeof(CommentFixtureModerate), "moderate")]
[JsonDerivedType(typeof(CommentFixtureReport), "report")]
[JsonDerivedType(typeof(CommentFixtureAppeal), "appeal")]
[JsonDerivedType(typeof(CommentFixtureReviewAppeal), "review-appeal")]
public abstract record CommentFixtureMutationCommand;

public sealed record CommentFixtureEdit(string Content) : CommentFixtureMutationCommand;
public sealed record CommentFixtureSoftDelete : CommentFixtureMutationCommand;
public sealed record CommentFixtureModerate([property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long AdminPrincipalId, CommentModerationRequest Request)
    : CommentFixtureMutationCommand;
public sealed record CommentFixtureReport(int ReporterAccountId, CommentReportRequest Request)
    : CommentFixtureMutationCommand;
public sealed record CommentFixtureAppeal(string Reason) : CommentFixtureMutationCommand;
public sealed record CommentFixtureReviewAppeal([property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long AppealId, [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long ReviewerAdminPrincipalId,
    CommentAppealDecisionRequest Request) : CommentFixtureMutationCommand;

/// <summary>Consumes an admitted initial identity; does not replace upstream receipt admission.</summary>
public sealed record CommentFixtureMutationPlan(
    CommentFixturePortBinding Binding,
    string SemanticRole,
    CommentThreadFixtureObservationIdentity Identity,
    int ExpectedVersion,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] CommentModerationStatus ExpectedStatus,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long ExpectedLastModerationEventId,
    DateTime BusinessTimeUtc,
    string ActorReferenceDigest,
    string SecurityReferenceDigest,
    string PolicyDigest,
    string CommandDigest,
    CommentFixtureMutationCommand Command)
{
    [JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)]
    public long? ExpectedAppealTargetEventId
    {
        get; init;
    }
}

public sealed record CommentFixtureModerationEventObservation(
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long Id,
    string EventType,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] CommentModerationStatus? PreviousStatus,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] CommentModerationStatus NextStatus,
    string ActorType,
    string? ReasonCode,
    string? PolicyVersion,
    string? ModelVersion,
    string TransitionSource,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long? AdminPrincipalId,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long? AppealId,
    DateTime OccurredAtUtc);

public sealed record CommentFixtureMutationObservation(
    int CurrentVersion,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] CommentModerationStatus ModerationStatus,
    bool IsDeleted,
    string ContentDigest,
    IReadOnlyList<CommentRevisionResult> Revisions,
    IReadOnlyList<CommentFixtureModerationEventObservation> ModerationEvents,
    IReadOnlyList<string> OutboxEventIds);

/// <summary>Command and independently reread facts, without delivery or runtime qualification.</summary>
public sealed record CommentFixtureMutationResult(
    CommentFixturePortBinding Binding,
    string SemanticRole,
    CommentThreadFixtureObservationIdentity Identity,
    DateTime BusinessTimeUtc,
    string ActorReferenceDigest,
    string SecurityReferenceDigest,
    string PolicyDigest,
    string CommandDigest,
    CommentFixtureMutationObservation Before,
    CommentFixtureMutationObservation After,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long? ReportId,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long? AppealId);

public sealed partial class CommentThreadFixturePort
{
    public static string ComputeCommandDigest(CommentFixtureMutationCommand command)
        => Digest(JsonSerializer.Serialize(command));

    public async Task<CommentFixtureMutationResult> ExecuteMutationAsync(
        CommentFixtureMutationPlan plan,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateMutationPlan(plan);
        if (timeProvider.GetUtcNow().UtcDateTime != plan.BusinessTimeUtc)
            throw new InvalidOperationException("Comment mutation business time differs from the injected temporal context.");

        Comment beforeRow = await RequireCommentAsync(plan.Identity.CommentId, cancellationToken).ConfigureAwait(false);
        var identity = new FixtureIdentity(beforeRow.Id, plan.Identity.AccountId, plan.Identity.ActorMode,
            plan.Identity.OperationPlanDigest, plan.Identity.CapabilityId);
        var operation = new CommentThreadFixtureOperation(plan.Identity.CapabilityId, plan.SemanticRole,
            CommentThreadFixtureOperations.Edit, identity.ActorMode, identity.AccountId, beforeRow.Content);
        RequireOwnedMutation(beforeRow, plan.Binding, operation, identity);
        if (beforeRow.CurrentVersion != plan.ExpectedVersion || beforeRow.ModerationStatus != plan.ExpectedStatus)
            throw new InvalidOperationException("Comment mutation revision or status is stale.");
        CommentFixtureMutationObservation before = await ReadMutationObservationAsync(beforeRow, cancellationToken)
            .ConfigureAwait(false);
        if (identity.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            // Compare immutable initial content, not a later edited revision, against the initial ledger.
            await RequireAnonymousOwnershipAsync(plan.Binding, plan.SemanticRole, identity, beforeRow, cancellationToken,
                before.Revisions.Single(revision => revision.Version == 1).Content).ConfigureAwait(false);
        }
        if (before.ModerationEvents[^1].Id != plan.ExpectedLastModerationEventId)
            throw new InvalidOperationException("Comment mutation moderation event is stale.");

        if (plan.Command is CommentFixtureAppeal
            && (beforeRow.ModerationStatus is not (CommentModerationStatus.Rejected or CommentModerationStatus.Hidden)
                || before.ModerationEvents.Where(item => item.EventType is CommentModerationEventTypes.Reject
                    or CommentModerationEventTypes.Hide).OrderByDescending(item => item.Id).FirstOrDefault()?.Id
                    != plan.ExpectedAppealTargetEventId))
            throw new InvalidOperationException("Comment mutation appeal decision is missing or stale.");

        long? reportId = null;
        long? appealId = null;
        switch (plan.Command)
        {
            case CommentFixtureEdit edit:
                await ExecuteAuthorMutationAsync(plan, beforeRow, CommentManagementPurposes.Edit, edit.Content,
                    cancellationToken).ConfigureAwait(false);
                break;
            case CommentFixtureSoftDelete:
                await ExecuteAuthorMutationAsync(plan, beforeRow, CommentManagementPurposes.Delete, null,
                    cancellationToken).ConfigureAwait(false);
                break;
            case CommentFixtureModerate moderate:
                if (!CommentModerationTransitions.IsAllowed(beforeRow.ModerationStatus, moderate.Request.Status))
                    throw new InvalidOperationException("Comment mutation is not an allowed production moderation transition.");
                if (!await moderationCommands.ModerateCommentAsync(moderate.AdminPrincipalId, beforeRow.Id,
                    moderate.Request, cancellationToken).ConfigureAwait(false))
                    throw new InvalidOperationException("Production comment moderation failed.");
                break;
            case CommentFixtureReport report:
                CommentReportResult reported = await governance.ReportAsAccountAsync(beforeRow.Id,
                    report.ReporterAccountId, report.Request, cancellationToken).ConfigureAwait(false);
                if (!reported.Success || reported.ReportId is not > 0)
                    throw new InvalidOperationException($"Production comment report failed: {reported.Code}.");
                reportId = reported.ReportId;
                break;
            case CommentFixtureAppeal appeal:
                string challenge = await IssueMutationChallengeAsync(plan, beforeRow, CommentManagementPurposes.Appeal,
                    cancellationToken).ConfigureAwait(false);
                var request = new CommentAppealRequest(appeal.Reason, challenge);
                CommentAppealResult appealed = identity.ActorMode == CommentAuthorModes.Public
                    ? await governance.AppealAsAccountAsync(beforeRow.Id, identity.AccountId!.Value, request,
                        cancellationToken).ConfigureAwait(false)
                    : await governance.AppealAsAnonymousAsync(beforeRow.Id,
                        RequireAnonymousCapability(plan.Binding.Owner, plan.Binding.TestSession, beforeRow.Id), request,
                        cancellationToken).ConfigureAwait(false);
                if (!appealed.Success || appealed.AppealId is not > 0)
                    throw new InvalidOperationException($"Production comment appeal failed: {appealed.Code}.");
                appealId = appealed.AppealId;
                break;
            case CommentFixtureReviewAppeal review:
                CommentAuthorAppeal? target = await db.Queryable<CommentAuthorAppeal>()
                    .Where(item => item.Id == review.AppealId && item.CommentId == beforeRow.Id)
                    .FirstAsync(cancellationToken).ConfigureAwait(false);
                if (target is null || target.Status != "pending" || target.TargetModerationEventId != plan.ExpectedAppealTargetEventId
                    || !before.ModerationEvents.Any(item => item.Id == target.TargetModerationEventId))
                    throw new InvalidOperationException("Comment mutation appeal target is missing or stale.");
                CommentAppealResult reviewed = await governance.ReviewAppealAsync(review.AppealId,
                    review.ReviewerAdminPrincipalId, review.Request, cancellationToken).ConfigureAwait(false);
                if (!reviewed.Success || reviewed.AppealId != review.AppealId)
                    throw new InvalidOperationException($"Production appeal review failed: {reviewed.Code}.");
                appealId = reviewed.AppealId;
                break;
        }

        Comment afterRow = await RequireCommentAsync(beforeRow.Id, cancellationToken).ConfigureAwait(false);
        RequirePreservedMutationIdentity(beforeRow, afterRow);
        CommentFixtureMutationObservation after = await ReadMutationObservationAsync(afterRow, cancellationToken)
            .ConfigureAwait(false);
        int expectedVersion = plan.Command is CommentFixtureEdit or CommentFixtureSoftDelete
            ? checked(plan.ExpectedVersion + 1) : plan.ExpectedVersion;
        if (after.CurrentVersion != expectedVersion
            || !before.Revisions.All(revision => after.Revisions.Contains(revision))
            || !before.ModerationEvents.SequenceEqual(after.ModerationEvents.Take(before.ModerationEvents.Count)))
            throw new InvalidOperationException("Production comment mutation rewrote its immutable history.");
        return new(plan.Binding, plan.SemanticRole, plan.Identity, plan.BusinessTimeUtc, plan.ActorReferenceDigest,
            plan.SecurityReferenceDigest, plan.PolicyDigest, plan.CommandDigest, before, after, reportId, appealId);
    }

    private async Task ExecuteAuthorMutationAsync(CommentFixtureMutationPlan plan, Comment row, string purpose,
        string? content, CancellationToken cancellationToken)
    {
        string challenge = await IssueMutationChallengeAsync(plan, row, purpose, cancellationToken).ConfigureAwait(false);
        bool account = plan.Identity.ActorMode == CommentAuthorModes.Public;
        string? secret = account ? null : RequireAnonymousCapability(plan.Binding.Owner, plan.Binding.TestSession, row.Id);
        CommentAuthorMutationResult result = purpose == CommentManagementPurposes.Edit
            ? account
                ? await authorManagement.EditAsAccountAsync(row.Id, plan.Identity.AccountId!.Value,
                    new CommentEditRequest(plan.ExpectedVersion, content!, challenge), cancellationToken).ConfigureAwait(false)
                : await authorManagement.EditAsAnonymousAsync(row.Id, secret!,
                    new CommentEditRequest(plan.ExpectedVersion, content!, challenge), cancellationToken).ConfigureAwait(false)
            : account
                ? await authorManagement.DeleteAsAccountAsync(row.Id, plan.Identity.AccountId!.Value, challenge,
                    cancellationToken).ConfigureAwait(false)
                : await authorManagement.DeleteAsAnonymousAsync(row.Id, secret!, challenge, cancellationToken).ConfigureAwait(false);
        RequireMutation(result, plan.SemanticRole);
    }

    private async Task<string> IssueMutationChallengeAsync(CommentFixtureMutationPlan plan, Comment row, string purpose,
        CancellationToken cancellationToken)
    {
        CommentManagementChallengeResult challenge = plan.Identity.ActorMode == CommentAuthorModes.Public
            ? await authorManagement.IssueAccountChallengeAsync(row.Id, plan.Identity.AccountId!.Value, purpose,
                cancellationToken).ConfigureAwait(false)
            : await RequireAnonymousChallengeAsync(row.Id,
                RequireAnonymousCapability(plan.Binding.Owner, plan.Binding.TestSession, row.Id), purpose,
                cancellationToken).ConfigureAwait(false);
        if (!challenge.Issued || string.IsNullOrWhiteSpace(challenge.Challenge)
            || challenge.CurrentVersion != plan.ExpectedVersion)
            throw new InvalidOperationException("Production comment management challenge is unavailable or stale.");
        return challenge.Challenge;
    }

    private async Task<CommentFixtureMutationObservation> ReadMutationObservationAsync(Comment row,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<CommentRevisionResult> revisions = await authorManagement.ReadRevisionsAsAdminAsync(row.Id,
            cancellationToken).ConfigureAwait(false);
        CommentModerationTimelineResult? timeline = await governance.ReadTimelineAsync(row.Id, cancellationToken)
            .ConfigureAwait(false);
        if (!HasExactRevisionHistory(row, revisions, string.Empty) || timeline is null
            || !CommentFixtureTimelineVerifier.IsConsistent(timeline, row.Id, row.ModerationStatus))
            throw new InvalidOperationException("Production comment mutation history or timeline is inconsistent.");
        List<CommentMutationOutboxEvent> outbox = await db.Queryable<CommentMutationOutboxEvent>()
            .Where(item => item.CommentId == row.Id && item.ArticleId == row.ArticleId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return new(row.CurrentVersion, row.ModerationStatus, row.IsDeleted, Digest(row.Content), revisions,
            timeline.Events.Select(item => new CommentFixtureModerationEventObservation(item.Id, item.EventType,
                item.PreviousStatus, item.NextStatus, item.ActorType, item.ReasonCode, item.PolicyVersion, item.ModelVersion,
                item.TransitionSource, item.AdminPrincipalId, item.AppealId, item.OccurredAtUtc)).ToArray(),
            outbox.Select(item => item.EventId).Order(StringComparer.Ordinal).ToArray());
    }

    private static void ValidateMutationPlan(CommentFixtureMutationPlan plan)
    {
        static bool IsDigest(string value) => value is not null && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;
        if (!plan.Binding.IsValid() || string.IsNullOrWhiteSpace(plan.SemanticRole)
            || plan.Identity.CommentId <= 0 || !IsAllowedCapability(plan.Identity.CapabilityId)
            || !IsDigest(plan.Identity.OperationPlanDigest) || plan.ExpectedVersion <= 0
            || !Enum.IsDefined(plan.ExpectedStatus) || plan.ExpectedLastModerationEventId <= 0
            || plan.BusinessTimeUtc.Kind != DateTimeKind.Utc || !IsDigest(plan.ActorReferenceDigest)
            || !IsDigest(plan.SecurityReferenceDigest) || !IsDigest(plan.PolicyDigest)
            || !StringComparer.Ordinal.Equals(plan.CommandDigest, ComputeCommandDigest(plan.Command))
            || (plan.Identity.ActorMode == CommentAuthorModes.Public
                ? plan.Identity.AccountId is not > 0
                : plan.Identity.ActorMode != CommentAuthorModes.ZkAnonymous || plan.Identity.AccountId is not null))
            throw new InvalidOperationException("Comment mutation plan binding is invalid.");
        bool valid = plan.Command switch
        {
            CommentFixtureEdit edit => !string.IsNullOrWhiteSpace(edit.Content),
            CommentFixtureSoftDelete => true,
            CommentFixtureModerate moderate => moderate.AdminPrincipalId > 0 && Enum.IsDefined(moderate.Request.Status)
                && !moderate.Request.BanUser && moderate.Request.ExpectedStatus == plan.ExpectedStatus
                && !string.IsNullOrWhiteSpace(moderate.Request.CommentRowVersion)
                && !string.IsNullOrWhiteSpace(moderate.Request.ClaimToken) && moderate.Request.ClaimGeneration is > 0
                && !string.IsNullOrWhiteSpace(moderate.Request.ClaimRowVersion),
            CommentFixtureReport report => report.ReporterAccountId > 0 && report.Request.ScopedCredential is null,
            CommentFixtureAppeal appeal => !string.IsNullOrWhiteSpace(appeal.Reason) && plan.ExpectedAppealTargetEventId is > 0,
            CommentFixtureReviewAppeal review => review.AppealId > 0 && review.ReviewerAdminPrincipalId > 0
                && plan.ExpectedAppealTargetEventId is > 0,
            _ => false
        };
        if (!valid)
            throw new InvalidOperationException("Comment mutation command is not supported by its formal port.");
    }

    private static void RequirePreservedMutationIdentity(Comment before, Comment after)
    {
        if (before.Id != after.Id || before.ArticleId != after.ArticleId || before.UserId != after.UserId
            || before.AuthorMode != after.AuthorMode || before.RootId != after.RootId || before.ParentId != after.ParentId
            || before.ReplyToCommentId != after.ReplyToCommentId || before.Depth != after.Depth
            || before.ManagementCapabilityHash != after.ManagementCapabilityHash
            || before.AnonymousNullifierHash != after.AnonymousNullifierHash
            || before.AnonymousTicketHash != after.AnonymousTicketHash || before.AnonymousScope != after.AnonymousScope
            || before.ReplyToUserId != after.ReplyToUserId || before.PublicHandle != after.PublicHandle
            || before.AnonymousHandle != after.AnonymousHandle || before.AnonymousDisplayName != after.AnonymousDisplayName
            || before.AnonymousDisplayLanguage != after.AnonymousDisplayLanguage
            || before.ModerationSubjectHash != after.ModerationSubjectHash || before.CredentialLevel != after.CredentialLevel
            || before.ReputationBucket != after.ReputationBucket || before.AccountAgeBucket != after.AccountAgeBucket
            || before.AnonymousRateClass != after.AnonymousRateClass
            || before.AnonymousRequiresModeration != after.AnonymousRequiresModeration)
            throw new InvalidOperationException("Production comment mutation changed its initial identity.");
    }
}
