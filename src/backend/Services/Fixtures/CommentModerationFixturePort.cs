// fixture-catalog: port comment-moderation-lifecycle
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
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

public sealed record CommentModerationFixturePlan(
    string Schema,
    string RunId,
    string Namespace,
    string Owner,
    long AdminPrincipalId,
    string InventoryDigest,
    IReadOnlyList<CommentModerationFixtureOperation> Operations);

public sealed record CommentModerationFixtureEntity(
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
    string? RegionCode,
    string? RegionPolicyVersion,
    bool? RegionRequiresManualReview,
    IReadOnlyList<string> RegionEvidence,
    IReadOnlyList<string> SignalEvidence,
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
    string RunId,
    string Namespace,
    string Owner,
    string InventoryDigest,
    CommentFixtureRuntimeSemantics RuntimeSemantics,
    IReadOnlyList<CommentModerationFixtureEntity> Entities);

public interface ICommentModerationFixturePort
{
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
    ISqlSugarClient db) : ICommentModerationFixturePort
{
    private const string PlanSchema = "fsusblog.comment-moderation-fixture-plan.v1";
    private const string ResultSchema = "fsusblog.comment-moderation-fixture-result.v1";

    public async Task<CommentModerationFixtureResult> ExecuteAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        foreach (CommentModerationFixtureOperation operation in plan.Operations)
        {
            Comment row = await RequireCommentAsync(operation.CommentId, cancellationToken).ConfigureAwait(false);
            CommentModerationStatus expectedRuntime = RuntimeStatus(operation.SemanticStatus);
            if (row.ModerationStatus != expectedRuntime
                || !StringComparer.Ordinal.Equals(row.ModerationReason, operation.Reason))
            {
                bool applied = await commands.ModerateCommentAsync(
                    plan.AdminPrincipalId,
                    operation.CommentId,
                    new CommentModerationRequest(expectedRuntime, operation.Reason),
                    cancellationToken).ConfigureAwait(false);
                if (!applied)
                    throw new InvalidOperationException($"Production moderation transition failed for {operation.SemanticRole}.");
            }
        }

        var queueMembership = new Dictionary<CommentModerationStatus, IReadOnlyList<string>>();
        foreach (CommentModerationStatus status in new[] {
            CommentModerationStatus.Pending,
            CommentModerationStatus.Rejected,
            CommentModerationStatus.Approved
        })
            queueMembership[status] = await ReadExactQueueAsync(status, cancellationToken).ConfigureAwait(false);

        var entities = new List<CommentModerationFixtureEntity>(plan.Operations.Count);
        foreach (CommentModerationFixtureOperation operation in plan.Operations.OrderBy(item => item.SemanticRole, StringComparer.Ordinal))
            entities.Add(await ObserveAsync(operation, plan.AdminPrincipalId, queueMembership, cancellationToken).ConfigureAwait(false));

        return new CommentModerationFixtureResult(
            ResultSchema,
            plan.RunId,
            plan.Namespace,
            plan.Owner,
            plan.InventoryDigest,
            BuildRuntimeSemantics(entities),
            entities);
    }

    private async Task<CommentModerationFixtureEntity> ObserveAsync(
        CommentModerationFixtureOperation operation,
        long adminPrincipalId,
        IReadOnlyDictionary<CommentModerationStatus, IReadOnlyList<string>> queues,
        CancellationToken cancellationToken)
    {
        Comment row = await RequireCommentAsync(operation.CommentId, cancellationToken).ConfigureAwait(false);
        CommentModerationStatus expectedRuntime = RuntimeStatus(operation.SemanticStatus);
        if (row.ModerationStatus != expectedRuntime
            || !StringComparer.Ordinal.Equals(row.ModerationReason, operation.Reason)
            || row.ModeratedByAdminPrincipalId != adminPrincipalId
            || row.ModeratedAt is null)
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
        if (operation.RequireSignalEvidence && signals.All(item => string.IsNullOrWhiteSpace(item.EvidenceJson)
            || string.IsNullOrWhiteSpace(item.Provider) || string.IsNullOrWhiteSpace(item.ContractVersion)))
            throw new InvalidOperationException($"Signal evidence is missing for {operation.SemanticRole}.");
        if (events.Count == 0 || outbox.Count == 0)
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

        return new CommentModerationFixtureEntity(
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
            region?.SubmitRegion,
            region?.PolicyVersion,
            region?.RequiresManualReview,
            [.. blocked.Select(item => Digest($"{item.RegionCode}\0{region?.PolicyVersion}\0{region?.RuleHitsJson}"))],
            [.. signals.Select(item => Digest($"{item.Provider}\0{item.ContractVersion}\0{item.Label}\0{item.EvidenceJson}"))],
            [.. events.Select(item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))],
            [.. outbox.Select(item => item.EventId)]);
    }

    private async Task<IReadOnlyList<string>> ReadExactQueueAsync(
        CommentModerationStatus status,
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
            CommentModerationFixtureEntity entity = entities.Single(item => item.SemanticStatus == status);
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
        if (plan.Schema != PlanSchema || string.IsNullOrWhiteSpace(plan.RunId)
            || string.IsNullOrWhiteSpace(plan.Namespace) || string.IsNullOrWhiteSpace(plan.Owner)
            || plan.AdminPrincipalId <= 0 || !IsDigest(plan.InventoryDigest) || plan.Operations.Count == 0)
            throw new InvalidOperationException("Comment moderation fixture plan is invalid.");
        string[] statuses = [.. plan.Operations.Select(item => item.SemanticStatus).Order(StringComparer.Ordinal)];
        if (!statuses.SequenceEqual(new[] { "approved", "pending", "rejected", "spam" }, StringComparer.Ordinal))
            throw new InvalidOperationException("Moderation fixture requires exact independent approved/pending/rejected/spam identities.");
        if (plan.Operations.Select(item => item.CommentId).Distinct().Count() != plan.Operations.Count
            || plan.Operations.Select(item => item.SemanticRole).Distinct(StringComparer.Ordinal).Count() != plan.Operations.Count)
            throw new InvalidOperationException("Moderation fixture states must use independent comment identities.");
    }

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";
}
