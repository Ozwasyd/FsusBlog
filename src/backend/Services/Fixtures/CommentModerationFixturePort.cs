// fixture-catalog: producer comment-moderation
// fixture-catalog: port comment-moderation-lifecycle
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CommentModerationFixtureOperation(
    string CapabilityId,
    string SemanticRole,
    long CommentId,
    string SemanticStatus,
    string Reason,
    bool RequireRegionEvidence,
    bool RequireSignalEvidence);

public sealed record CommentRegionFixtureEvidence(
    long CommentId,
    string Source,
    string RegionCode,
    string PolicyVersion,
    string DecisionDigest);

public sealed record CommentSignalFixtureEvidence(
    long SignalId,
    long CommentId,
    string Provider,
    string ContractVersion,
    string Classification,
    double Confidence,
    string EvidenceDigest);

public sealed record CommentModerationFixturePlan(
    string Schema,
    CommentFixturePortBinding Binding,
    long AdminPrincipalId,
    IReadOnlyList<CommentModerationFixtureOperation> Operations);

public sealed record CommentModerationFixtureEntity(
    string CapabilityId,
    string SemanticRole,
    long CommentId,
    string SemanticStatus,
    string RuntimeStatus,
    string? Reason,
    long? ModeratedByAdminPrincipalId,
    DateTime? ModeratedAt,
    bool PubliclyVisible,
    string QueueBucket,
    bool QueueMember,
    int QueueOrder,
    int QueueMembershipSize,
    string? RegionCode,
    string? RegionPolicyVersion,
    bool? RegionRequiresManualReview,
    IReadOnlyList<CommentRegionFixtureEvidence> RegionEvidence,
    IReadOnlyList<CommentSignalFixtureEvidence> SignalEvidence,
    IReadOnlyList<string> ModerationEventIds,
    IReadOnlyList<string> OutboxEventIds);

public sealed record CommentFixtureRuntimeSemantics(
    string Schema,
    IReadOnlyDictionary<string, string> PublicVisibility,
    IReadOnlyDictionary<string, string> QueueMembership,
    string SpamRuntimeStatus,
    string SpamEvidenceRequirement,
    string Source);

public sealed record CommentModerationFixtureResult(
    string Schema,
    CommentFixturePortBinding Binding,
    CommentFixtureRuntimeSemantics RuntimeSemantics,
    IReadOnlyList<CommentModerationFixtureEntity> Entities);

public interface ICommentModerationFixturePort
{
    RegionModerationDecision ResolveRegion(
        string content,
        int articleId,
        int accountId,
        string region,
        DateTime submittedAtUtc);

    Task TransitionAsync(
        CommentFixturePortBinding binding,
        long adminPrincipalId,
        CommentModerationFixtureOperation operation,
        CancellationToken cancellationToken = default);

    Task<CommentModerationFixtureResult> ExecuteAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Test-only typed moderation port. Status transitions use the production
/// authoring command; storage is queried only by the independent verifier.
/// </summary>
public sealed class CommentModerationFixturePort(
    IAuthoringModerationCommands commands,
    IAuthoringModerationQueue queue,
    ICommentQueryService publicQueries,
    IRegionLegalModerationService regionPolicies,
    CommentMutationOutboxWorker outboxWorker,
    ISqlSugarClient db) : ICommentModerationFixturePort
{
    private const string PlanSchema = "fsusblog.comment-moderation-fixture-plan.v1";
    private const int MaxOutboxDrainPasses = 16;
    private static readonly TimeSpan s_outboxDrainPassDelay = TimeSpan.FromMilliseconds(200);
    private const string ResultSchema = "fsusblog.comment-moderation-fixture-result.v1";

    public RegionModerationDecision ResolveRegion(
        string content,
        int articleId,
        int accountId,
        string region,
        DateTime submittedAtUtc)
    {
        if (string.IsNullOrWhiteSpace(content) || articleId <= 0 || accountId <= 0
            || string.IsNullOrWhiteSpace(region) || submittedAtUtc.Kind != DateTimeKind.Utc)
            throw new InvalidOperationException("Comment region fixture request is invalid.");
        return regionPolicies.EvaluateOnSubmit(new RegionModerationRequest(
            content,
            articleId,
            accountId,
            region,
            1d,
            "test-fixture-verified-region",
            null,
            null,
            submittedAtUtc));
    }

    public async Task<CommentModerationFixtureResult> ExecuteAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        foreach (CommentModerationFixtureOperation operation in plan.Operations)
            await TransitionAsync(plan.Binding, plan.AdminPrincipalId, operation, cancellationToken).ConfigureAwait(false);

        await DrainOutboxAsync(plan.Operations, cancellationToken).ConfigureAwait(false);

        var queueMembership = new Dictionary<CommentModerationStatus, IReadOnlyList<string>>();
        foreach (CommentModerationStatus status in new[] {
            CommentModerationStatus.Pending,
            CommentModerationStatus.Rejected,
            CommentModerationStatus.Approved
        })
        {
            // Approved membership means presence in the actionable moderation queue;
            // a plain status browse would list every approved comment and make the
            // "excluded" assertion unreachable.
            CommentModerationStatus? queueFilter = status == CommentModerationStatus.Approved ? null : status;
            queueMembership[status] = await ReadExactQueueAsync(queueFilter, cancellationToken).ConfigureAwait(false);
        }

        var entities = new List<CommentModerationFixtureEntity>(plan.Operations.Count);
        foreach (CommentModerationFixtureOperation operation in plan.Operations.OrderBy(item => item.SemanticRole, StringComparer.Ordinal))
            entities.Add(await ObserveAsync(operation, plan.AdminPrincipalId, queueMembership, cancellationToken).ConfigureAwait(false));

        return new CommentModerationFixtureResult(
            ResultSchema,
            plan.Binding,
            BuildRuntimeSemantics(entities),
            entities);
    }

    public async Task TransitionAsync(
        CommentFixturePortBinding binding,
        long adminPrincipalId,
        CommentModerationFixtureOperation operation,
        CancellationToken cancellationToken = default)
    {
        if (!binding.IsValid() || adminPrincipalId <= 0 || operation.CommentId <= 0)
            throw new InvalidOperationException("Comment moderation transition references are invalid.");
        Comment row = await RequireCommentAsync(operation.CommentId, cancellationToken).ConfigureAwait(false);
        CommentModerationStatus expectedRuntime = RuntimeStatus(operation.SemanticStatus);
        if (row.ModerationStatus == expectedRuntime
            && (string.IsNullOrWhiteSpace(operation.Reason)
                || StringComparer.Ordinal.Equals(row.ModerationReason, operation.Reason)))
            return;
        bool applied = await commands.ModerateCommentAsync(
            adminPrincipalId,
            operation.CommentId,
            new CommentModerationRequest(expectedRuntime, operation.Reason),
            cancellationToken).ConfigureAwait(false);
        if (!applied)
            throw new InvalidOperationException($"Production moderation transition failed for {operation.SemanticRole}.");
    }

    private async Task<CommentModerationFixtureEntity> ObserveAsync(
        CommentModerationFixtureOperation operation,
        long adminPrincipalId,
        IReadOnlyDictionary<CommentModerationStatus, IReadOnlyList<string>> queues,
        CancellationToken cancellationToken)
    {
        Comment row = await RequireCommentAsync(operation.CommentId, cancellationToken).ConfigureAwait(false);
        CommentModerationStatus expectedRuntime = RuntimeStatus(operation.SemanticStatus);
        bool initialPending = operation.CapabilityId == "comment.moderation.pending";
        bool regionObservation = operation.CapabilityId.StartsWith("comment.region.", StringComparison.Ordinal);
        if (row.ModerationStatus != expectedRuntime
            || (!string.IsNullOrWhiteSpace(operation.Reason)
                && !StringComparer.Ordinal.Equals(row.ModerationReason, operation.Reason))
            || (!initialPending && !regionObservation
                && (row.ModeratedByAdminPrincipalId != adminPrincipalId || row.ModeratedAt is null)))
            throw new InvalidOperationException($"Moderation storage observation is incomplete for {operation.SemanticRole}.");

        CommentRegionCompliance? region = await db.Queryable<CommentRegionCompliance>()
            .Where(item => item.CommentId == row.Id)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        List<CommentBlockedRegion> blocked = await db.Queryable<CommentBlockedRegion>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.RegionCode, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        List<CommentModerationSignal> signals = await db.Queryable<CommentModerationSignal>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        List<CommentModerationEvent> events = await db.Queryable<CommentModerationEvent>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        List<CommentMutationOutboxEvent> outbox = await db.Queryable<CommentMutationOutboxEvent>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

        if (operation.RequireRegionEvidence && (region is null || string.IsNullOrWhiteSpace(region.PolicyVersion)
            || string.IsNullOrWhiteSpace(region.DecisionReason)))
            throw new InvalidOperationException($"Region evidence is missing for {operation.SemanticRole}.");
        if (operation.RequireSignalEvidence && (signals.Count == 0
            || signals.Any(item => string.IsNullOrWhiteSpace(item.EvidenceJson)
                || string.IsNullOrWhiteSpace(item.Provider) || string.IsNullOrWhiteSpace(item.ContractVersion)
                || string.IsNullOrWhiteSpace(item.Label) || !double.IsFinite(item.Confidence)
                || item.Confidence is < 0d or > 1d)))
            throw new InvalidOperationException($"Signal evidence is missing for {operation.SemanticRole}.");
        if ((!initialPending && !regionObservation && events.Count == 0) || outbox.Count == 0)
            throw new InvalidOperationException($"Moderation audit/outbox evidence is missing for {operation.SemanticRole}.");

        CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(row.ArticleId, row.Id)
            .ConfigureAwait(false);
        bool publiclyVisible = publicProjection.Status == "found";
        if (publiclyVisible != (expectedRuntime == CommentModerationStatus.Approved))
            throw new InvalidOperationException($"Public moderation projection drifted for {operation.SemanticRole}.");

        IReadOnlyList<string> queueIds = queues[expectedRuntime];
        string commentId = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        int queueOrder = queueIds.ToList().FindIndex(item => StringComparer.Ordinal.Equals(item, commentId));
        bool queueMember = queueOrder >= 0;
        bool expectedQueueMember = expectedRuntime is CommentModerationStatus.Pending or CommentModerationStatus.Rejected;
        if (queueMember != expectedQueueMember)
            throw new InvalidOperationException($"Queue membership drifted for {operation.SemanticRole}.");
        var regionEvidence = new List<CommentRegionFixtureEvidence>();
        if (region is not null)
            regionEvidence.Add(new(
                row.Id,
                "comment_region_compliance",
                region.SubmitRegion,
                region.PolicyVersion,
                Digest($"{region.SubmitRegion}\0{region.PolicyVersion}\0{region.DecisionReason}\0{region.RuleHitsJson}")));
        regionEvidence.AddRange(blocked.Select(item =>
            new CommentRegionFixtureEvidence(
                row.Id,
                "comment_blocked_region",
                item.RegionCode,
                region?.PolicyVersion ?? string.Empty,
                Digest($"{item.RegionCode}\0{region?.PolicyVersion}\0{region?.RuleHitsJson}"))));
        CommentSignalFixtureEvidence[] signalEvidence = [.. signals.Select(item =>
            new CommentSignalFixtureEvidence(
                item.Id,
                item.CommentId,
                item.Provider,
                item.ContractVersion,
                item.Label,
                item.Confidence,
                Digest(item.EvidenceJson ?? string.Empty)))];

        return new CommentModerationFixtureEntity(
            operation.CapabilityId,
            operation.SemanticRole,
            row.Id,
            operation.SemanticStatus,
            expectedRuntime.ToString().ToLowerInvariant(),
            row.ModerationReason,
            row.ModeratedByAdminPrincipalId,
            row.ModeratedAt,
            publiclyVisible,
            expectedRuntime.ToString().ToLowerInvariant(),
            queueMember,
            queueOrder,
            queueIds.Count,
            region?.SubmitRegion,
            region?.PolicyVersion,
            region?.RequiresManualReview,
            regionEvidence,
            signalEvidence,
            [.. events.Select(item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))],
            [.. outbox.Select(item => item.EventId)]);
    }

    private async Task DrainOutboxAsync(
        IReadOnlyList<CommentModerationFixtureOperation> operations,
        CancellationToken cancellationToken)
    {
        long[] commentIds = operations.Select(static item => item.CommentId).Distinct().ToArray();
        for (int pass = 0; pass < MaxOutboxDrainPasses; pass++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            List<CommentMutationOutboxEvent> pending = await db.Queryable<CommentMutationOutboxEvent>()
                .Where(item => commentIds.Contains(item.CommentId)
                    && item.Status != CommentMutationOutboxStatus.Processed)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
            if (pending.Count == 0)
            {
                return;
            }
            if (pending.Any(static item => item.Status == CommentMutationOutboxStatus.Poison))
            {
                throw new InvalidOperationException("Comment mutation outbox did not reach exact processed state.");
            }
            // Rows may be in-flight under the hosted worker's claim lease; give the
            // current claim owner a bounded window to commit before the next pass.
            await Task.Delay(s_outboxDrainPassDelay, cancellationToken).ConfigureAwait(false);
            await outboxWorker.ProcessPendingAsync(cancellationToken).ConfigureAwait(false);
        }
        throw new InvalidOperationException("Comment mutation outbox did not converge within the bounded worker drain.");
    }

    private async Task<IReadOnlyList<string>> ReadExactQueueAsync(
        CommentModerationStatus? status,
        CancellationToken cancellationToken)
    {
        var ids = new List<string>();
        string? cursor = null;
        do
        {
            CommentModerationQueueResponse page = await queue.ListCommentModerationQueuePageAsync(
                status, 100, cursor, cancellationToken).ConfigureAwait(false);
            ids.AddRange(page.Items.Select(item => item.Id));
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        if (ids.Distinct(StringComparer.Ordinal).Count() != ids.Count)
            throw new InvalidOperationException($"Moderation queue {status} contains duplicate identities.");
        return ids;
    }

    private static CommentFixtureRuntimeSemantics BuildRuntimeSemantics(
        IReadOnlyList<CommentModerationFixtureEntity> entities)
    {
        string[] statuses = ["approved", "pending", "rejected", "spam"];
        var visibility = new Dictionary<string, string>(StringComparer.Ordinal);
        var queues = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string status in statuses)
        {
            CommentModerationFixtureEntity entity = entities.Single(item =>
                item.CapabilityId == $"comment.moderation.{status}");
            visibility[status] = entity.PubliclyVisible ? "visible-exact" : "hidden-exact";
            queues[status] = entity.QueueMember
                ? $"included-{entity.QueueBucket}"
                : "excluded";
        }
        return new CommentFixtureRuntimeSemantics(
            "fsusblog.comment-fixture-runtime-semantics.v1",
            visibility,
            queues,
            "rejected",
            "provider-version-classification-evidence-ref",
            "production-comment-query-and-authoring-moderation-queue");
    }

    private async Task<Comment> RequireCommentAsync(long id, CancellationToken cancellationToken)
        => await db.Queryable<Comment>().Where(item => item.Id == id && !item.IsDeleted)
            .FirstAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Comment {id} is not an active #2159 reference.");

    private static CommentModerationStatus RuntimeStatus(string semanticStatus) => semanticStatus switch
    {
        "approved" => CommentModerationStatus.Approved,
        "pending" => CommentModerationStatus.Pending,
        "rejected" => CommentModerationStatus.Rejected,
        "spam" => CommentModerationStatus.Rejected,
        _ => throw new InvalidOperationException($"Unknown moderation semantic status {semanticStatus}.")
    };

    private static void ValidatePlan(CommentModerationFixturePlan plan)
    {
        if (plan.Schema != PlanSchema || !plan.Binding.IsValid()
            || plan.AdminPrincipalId <= 0 || plan.Operations.Count == 0)
            throw new InvalidOperationException("Comment moderation fixture plan is invalid.");
        string[] expectedCapabilities =
        [
            "comment.moderation.approved",
            "comment.moderation.pending",
            "comment.moderation.rejected",
            "comment.moderation.spam",
            "comment.region.global",
            "comment.region.manual-review"
        ];
        if (!plan.Operations.Select(item => item.CapabilityId).Order(StringComparer.Ordinal)
            .SequenceEqual(expectedCapabilities, StringComparer.Ordinal))
            throw new InvalidOperationException("Moderation fixture requires the exact independent state and region capability set.");
        var expectedStatuses = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["comment.moderation.approved"] = "approved",
            ["comment.moderation.pending"] = "pending",
            ["comment.moderation.rejected"] = "rejected",
            ["comment.moderation.spam"] = "spam",
            ["comment.region.global"] = "approved",
            ["comment.region.manual-review"] = "pending"
        };
        if (plan.Operations.Any(item => expectedStatuses[item.CapabilityId] != item.SemanticStatus))
            throw new InvalidOperationException("Moderation fixture capability/status binding drifted.");
        if (plan.Operations.Select(item => item.CommentId).Distinct().Count() != plan.Operations.Count
            || plan.Operations.Select(item => item.SemanticRole).Distinct(StringComparer.Ordinal).Count() != plan.Operations.Count)
            throw new InvalidOperationException("Moderation fixture states must use independent comment identities.");
    }

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";
}
