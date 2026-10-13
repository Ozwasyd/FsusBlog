// fixture-catalog: producer comment-moderation
// fixture-catalog: port comment-moderation-lifecycle
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Owner-bound lease over the moderation runtime states the port matrix needs.
/// The port snapshots the exact prior region/model state and restores it on
/// release; the producer never touches the runtime-state service itself.
/// </summary>
public sealed record CommentModerationRuntimeLease(
    string Schema,
    CommentFixturePortBinding Binding,
    string Region,
    string PriorRegionState,
    string AppliedRegionState,
    bool PriorModelEnabled,
    string PriorModelProvider,
    string PriorModelProfile,
    string PriorModelThresholdProfile,
    string PriorModelContractVersion,
    string Owner,
    string PriorStateDigest,
    string AppliedStateDigest)
{
    // Only the in-process port can attach native runtime custody. JSON receipts
    // remain observations and cannot be imported as restoration authority.
    [System.Text.Json.Serialization.JsonIgnore]
    internal object? Custody
    {
        get; init;
    }
}

/// <summary>Preserves the acquisition cause and an independent failed release.</summary>
public sealed class CommentModerationRuntimeAcquisitionException(
    Exception originalError,
    Exception cleanupError)
    : Exception("Comment fixture runtime acquisition failed and its owned release was incomplete.", originalError)
{
    public Exception CleanupError { get; } = cleanupError;
}

public sealed record CommentModerationRuntimeRestore(
    string Schema,
    CommentFixturePortBinding Binding,
    string LeaseDigest,
    string RestoredRegionState,
    bool RestoredModelEnabled,
    string RestoredModelProvider,
    string RestoredModelProfile,
    string RestoredModelThresholdProfile,
    string RestoredModelContractVersion,
    string Owner,
    string RestoredStateDigest,
    bool Exact);

/// <summary>
/// Post-cleanup moderation observation: every owned comment is soft-deleted,
/// absent from both production queue projections, and hidden from the public
/// read model. Emitted only when all postconditions hold exactly.
/// </summary>
public sealed record CommentModerationCleanupObservation(
    string Schema,
    CommentFixturePortBinding Binding,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> CommentIds,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> QueueAbsentCommentIds,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> PublicHiddenCommentIds,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] IReadOnlyList<long> SoftDeletedCommentIds,
    string ObservationDigest);

public sealed record CommentModerationFixtureOperation(
    string CapabilityId,
    string SemanticRole,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    string SemanticStatus,
    string Reason,
    bool RequireRegionEvidence,
    bool RequireSignalEvidence)
{
    // This is the exact operation digest emitted by the #2159 comment port.
    // Moderation may consume that identity, but never create or rewrite it.
    public string CommentReferenceDigest { get; init; } = string.Empty;
    public string ReasonId { get; init; } = string.Empty;
    public string? RegionStateId
    {
        get; init;
    }
    public string? SignalStateId
    {
        get; init;
    }
}

public sealed record CommentRegionFixtureEvidence(
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    string Source,
    string RegionCode,
    string PolicyVersion,
    string DecisionDigest)
{
    public string Provider { get; init; } = string.Empty;
    public bool CanPublish
    {
        get; init;
    }
    public bool RequiresManualReview
    {
        get; init;
    }
    public bool HideUntilReviewed
    {
        get; init;
    }
    public string DecisionReason { get; init; } = string.Empty;
    public IReadOnlyList<string> BlockedRegions { get; init; } = [];
    public IReadOnlyList<string> ApplicableRegions { get; init; } = [];
}

public sealed record CommentSignalFixtureEvidence(
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long SignalId,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    string Provider,
    string ContractVersion,
    string Classification,
    double Confidence,
    string EvidenceDigest)
{
    public string Source { get; init; } = string.Empty;
    public string Model { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public double Score
    {
        get; init;
    }
    public IReadOnlyList<string> EvidenceRefs { get; init; } = [];
}

public sealed record CommentModerationFixturePlan(
    string Schema,
    CommentFixturePortBinding Binding,
    long AdminPrincipalId,
    IReadOnlyList<CommentModerationFixtureOperation> Operations)
{
    // Narrow #1713 auth-session reference; the numeric principal is not enough
    // to prove that the fixture consumed the planned admin identity.
    public string AdminActorReferenceDigest { get; init; } = string.Empty;
}

public sealed record CommentModerationFixtureEntity(
    string CapabilityId,
    string SemanticRole,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long CommentId,
    string SemanticStatus,
    string RuntimeStatus,
    string? Reason,
    [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.WriteAsString | System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString)] long? ModeratedByAdminPrincipalId,
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
    IReadOnlyList<string> OutboxEventIds)
{
    public bool AdminVisible
    {
        get; init;
    }
    public string AdminStatus { get; init; } = string.Empty;
    public string AdminModerationActor { get; init; } = string.Empty;
    public string QueueGroup { get; init; } = string.Empty;
    public string? QueueReason
    {
        get; init;
    }
    public string QueueActor { get; init; } = string.Empty;
    public string CommentReferenceDigest { get; init; } = string.Empty;
    public string ReasonId { get; init; } = string.Empty;
    public string? RegionStateId
    {
        get; init;
    }
    public string? SignalStateId
    {
        get; init;
    }
    public IReadOnlyList<string> ApplicableRegions { get; init; } = [];
    public int ArticleId
    {
        get; init;
    }
    public string CacheIdentity { get; init; } = string.Empty;
    public string CacheGeneration { get; init; } = string.Empty;
}

public sealed record CommentFixtureRuntimeSemantics(
    string Schema,
    IReadOnlyDictionary<string, string> PublicVisibility,
    IReadOnlyDictionary<string, string> QueueMembership,
    string SpamRuntimeStatus,
    string SpamEvidenceRequirement,
    string Source)
{
    public IReadOnlyDictionary<string, string> AdminVisibility
    {
        get; init;
    }
        = new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed record CommentModerationFixtureResult(
    string Schema,
    CommentFixturePortBinding Binding,
    CommentFixtureRuntimeSemantics RuntimeSemantics,
    IReadOnlyList<CommentModerationFixtureEntity> Entities)
{
    public string ContentDigest { get; init; } = string.Empty;
}

public interface ICommentModerationFixturePort
{
    RegionModerationDecision ResolveRegion(
        string content,
        int articleId,
        int accountId,
        string region,
        DateTime submittedAtUtc);

    CommentModerationRuntimeLease AcquireRuntimeState(
        CommentFixturePortBinding binding,
        string manualReviewRegion);

    CommentModerationRuntimeRestore RestoreRuntimeState(
        CommentModerationRuntimeLease lease);

    Task<string?> ReadCommentCacheGenerationAsync(
        int articleId,
        CancellationToken cancellationToken = default);

    Task<CommentModerationCleanupObservation> VerifyCleanupAsync(
        CommentFixturePortBinding binding,
        IReadOnlyList<long> commentIds,
        CancellationToken cancellationToken = default);

    Task TransitionAsync(
        CommentFixturePortBinding binding,
        long adminPrincipalId,
        CommentModerationFixtureOperation operation,
        CancellationToken cancellationToken = default);

    Task<CommentModerationFixtureResult> ExecuteAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default);

    Task<CommentModerationFixtureResult> ObserveCurrentAsync(
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
    IModerationRuntimeStateService runtimeState,
    CommentFixtureCacheProbe cacheProbe,
    ISqlSugarClient db,
    TimeProvider timeProvider) : ICommentModerationFixturePort
{
    private static readonly System.Buffers.SearchValues<char> s_myChars = System.Buffers.SearchValues.Create("0123456789abcdef");
    private const string PlanSchema = "fsusblog.comment-moderation-fixture-plan.v1";
    private const int MaxOutboxDrainPasses = 16;
    private static readonly TimeSpan s_outboxDrainPassDelay = TimeSpan.FromMilliseconds(200);
    private const string ResultSchema = "fsusblog.comment-moderation-fixture-result.v1";
    private const string RuntimeLeaseSchema = "fsusblog.comment-moderation-runtime-lease.v1";
    private const string RuntimeRestoreSchema = "fsusblog.comment-moderation-runtime-restore.v1";
    private const string CleanupObservationSchema = "fsusblog.comment-moderation-cleanup-observation.v1";

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

    public CommentModerationRuntimeLease AcquireRuntimeState(
        CommentFixturePortBinding binding,
        string manualReviewRegion)
    {
        if (!binding.IsValid() || string.IsNullOrWhiteSpace(manualReviewRegion))
            throw new InvalidOperationException("Comment moderation runtime lease binding is invalid.");
        ModerationRuntimeFixtureLease native = runtimeState.AcquireCommentFixtureRuntimeState(
            manualReviewRegion, binding.Owner, binding.RunId,
            timeProvider.GetUtcNow().UtcDateTime.AddMinutes(15))
            ?? throw new InvalidOperationException("Comment moderation runtime owner did not return native custody.");
        try
        {
            ModerationModelRuntimeSnapshot priorModel = native.Prior.Model;
            ModerationModelRuntimeSnapshot appliedModel = native.Applied.Model;
            if (RegionState(native.Applied, native.Region) != ModerationRegionStates.ManualReviewOnly
                || !appliedModel.Enabled)
                throw new InvalidOperationException("Comment moderation runtime lease did not reach the required owned state.");
            var lease = new CommentModerationRuntimeLease(
                RuntimeLeaseSchema,
                binding,
                native.Region,
                RegionState(native.Prior, native.Region),
                ModerationRegionStates.ManualReviewOnly,
                priorModel.Enabled,
                priorModel.Provider,
                priorModel.ModelProfile,
                priorModel.ThresholdProfile,
                priorModel.ContractVersion,
                binding.Owner,
                RuntimeStateDigest(native.Prior),
                RuntimeStateDigest(native.Applied));
            return lease with
            {
                Custody = new RuntimeLeaseCustody(native, JsonSerializer.Serialize(lease))
            };
        }
        catch (Exception acquisitionError)
        {
            try
            {
                native.Restore();
            }
            catch (Exception cleanupError)
            {
                throw new CommentModerationRuntimeAcquisitionException(acquisitionError, cleanupError);
            }
            throw;
        }
    }

    public CommentModerationRuntimeRestore RestoreRuntimeState(
        CommentModerationRuntimeLease lease)
    {
        if (lease.Schema != RuntimeLeaseSchema || !lease.Binding.IsValid()
            || string.IsNullOrWhiteSpace(lease.Region) || string.IsNullOrWhiteSpace(lease.PriorRegionState)
            || !StringComparer.Ordinal.Equals(lease.Owner, lease.Binding.Owner)
            || !IsDigest(lease.PriorStateDigest) || !IsDigest(lease.AppliedStateDigest)
            || lease.Custody is not RuntimeLeaseCustody custody)
            throw new InvalidOperationException("Comment moderation runtime lease is invalid.");
        string payload = JsonSerializer.Serialize(lease);
        if (!StringComparer.Ordinal.Equals(payload, custody.Payload))
            throw new InvalidOperationException("Comment moderation runtime lease differs from its native custody.");
        // Actual owner release validates applied incarnation and restores the
        // whole prior object plus rollback slot. A digest cannot grant release.
        ModerationRuntimeSnapshot restored = custody.Native.Restore();
        ModerationModelRuntimeSnapshot model = restored.Model;
        return new CommentModerationRuntimeRestore(
            RuntimeRestoreSchema,
            lease.Binding,
            Digest(payload),
            RegionState(restored, lease.Region),
            model.Enabled,
            model.Provider,
            model.ModelProfile,
            model.ThresholdProfile,
            model.ContractVersion,
            lease.Owner,
            RuntimeStateDigest(restored),
            Exact: true);
    }

    private sealed record RuntimeLeaseCustody(
        ModerationRuntimeFixtureLease Native,
        string Payload);

    private static string RegionState(ModerationRuntimeSnapshot snapshot, string region)
        => snapshot.RegionStates.TryGetValue(region, out string? state)
            ? state
            : ModerationRegionStates.Enabled;

    // The wire digest observes all public snapshot metadata. Built-in runtime
    // custody (including private scoring state) is retained by actual reference,
    // not inferred from serialization or a reduced scalar tuple.
    private static string RuntimeStateDigest(ModerationRuntimeSnapshot snapshot)
        => Digest(JsonSerializer.Serialize(snapshot));

    public Task<string?> ReadCommentCacheGenerationAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        if (articleId <= 0)
            throw new InvalidOperationException("Comment moderation cache observation requires an exact article reference.");
        return cacheProbe.ReadCursorGenerationAsync(
            $"article:{articleId.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            cancellationToken);
    }

    public async Task<CommentModerationCleanupObservation> VerifyCleanupAsync(
        CommentFixturePortBinding binding,
        IReadOnlyList<long> commentIds,
        CancellationToken cancellationToken = default)
    {
        if (!binding.IsValid() || commentIds.Count == 0
            || commentIds.Any(item => item <= 0)
            || commentIds.Distinct().Count() != commentIds.Count)
            throw new InvalidOperationException("Comment moderation cleanup observation request is invalid.");
        QueueSnapshot pending = await ReadExactQueueAsync(
            CommentModerationStatus.Pending,
            cancellationToken).ConfigureAwait(false);
        QueueSnapshot rejected = await ReadExactQueueAsync(
            CommentModerationStatus.Rejected,
            cancellationToken).ConfigureAwait(false);
        var queued = new HashSet<string>(
            pending.Items.Concat(rejected.Items).Select(item => item.Id),
            StringComparer.Ordinal);
        List<Comment> rows = await db.Queryable<Comment>()
            .Where(item => commentIds.Contains(item.Id))
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count != commentIds.Count)
            throw new InvalidOperationException("Comment moderation cleanup observation lost owned identities.");
        var queueAbsent = new List<long>(rows.Count);
        var publicHidden = new List<long>(rows.Count);
        var softDeleted = new List<long>(rows.Count);
        foreach (Comment row in rows)
        {
            string commentId = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (!row.IsDeleted)
                throw new InvalidOperationException($"Comment {row.Id} remains active after cleanup.");
            if (queued.Contains(commentId))
                throw new InvalidOperationException($"Comment {row.Id} remains in the production moderation queue after cleanup.");
            CommentPermalinkContextDto projection = await publicQueries
                .GetPermalinkContextAsync(row.ArticleId, row.Id)
                .ConfigureAwait(false);
            if (projection.Status == "found")
                throw new InvalidOperationException($"Comment {row.Id} remains visible in the public read model after cleanup.");
            queueAbsent.Add(row.Id);
            publicHidden.Add(row.Id);
            softDeleted.Add(row.Id);
        }
        return new CommentModerationCleanupObservation(
            CleanupObservationSchema,
            binding,
            [.. commentIds.Order()],
            queueAbsent,
            publicHidden,
            softDeleted,
            Digest(JsonSerializer.Serialize(new
            {
                schema = CleanupObservationSchema,
                binding,
                queueAbsent,
                publicHidden,
                softDeleted
            })));
    }

    public async Task<CommentModerationFixtureResult> ExecuteAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        foreach (CommentModerationFixtureOperation operation in plan.Operations)
            await TransitionAsync(plan.Binding, plan.AdminPrincipalId, operation, cancellationToken).ConfigureAwait(false);

        await DrainOutboxAsync(plan.Operations, cancellationToken).ConfigureAwait(false);

        return await ObserveCurrentAsync(plan, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Independent reads only: no transition, drain, runtime lease or cache repair.</summary>
    public async Task<CommentModerationFixtureResult> ObserveCurrentAsync(
        CommentModerationFixturePlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);

        var queueMembership = new Dictionary<CommentModerationStatus, QueueSnapshot>
        {
            // The production queue has two read contracts: Pending/null is the
            // actionable queue, while Rejected/Approved are status-browse projections.
            // Keep both observations separate so an approved status browse cannot be
            // mistaken for queue membership.
            [CommentModerationStatus.Pending] = await ReadExactQueueAsync(
                CommentModerationStatus.Pending,
                cancellationToken).ConfigureAwait(false),
            [CommentModerationStatus.Rejected] = await ReadExactQueueAsync(
                CommentModerationStatus.Rejected,
                cancellationToken).ConfigureAwait(false),
            [CommentModerationStatus.Approved] = await ReadExactQueueAsync(
                status: null,
                cancellationToken).ConfigureAwait(false)
        };

        var adminReadModels = new Dictionary<CommentModerationStatus, QueueSnapshot>
        {
            // Read the admin projection independently; sharing the queue result
            // would make the admin-status proof vacuous for pending/rejected.
            [CommentModerationStatus.Pending] = await ReadExactQueueAsync(
                CommentModerationStatus.Pending,
                cancellationToken).ConfigureAwait(false),
            [CommentModerationStatus.Rejected] = await ReadExactQueueAsync(
                CommentModerationStatus.Rejected,
                cancellationToken).ConfigureAwait(false),
            [CommentModerationStatus.Approved] = await ReadExactQueueAsync(
                CommentModerationStatus.Approved,
                cancellationToken).ConfigureAwait(false)
        };

        var entities = new List<CommentModerationFixtureEntity>(plan.Operations.Count);
        foreach (CommentModerationFixtureOperation operation in plan.Operations.OrderBy(item => item.SemanticRole, StringComparer.Ordinal))
            entities.Add(await ObserveAsync(
                operation,
                plan.AdminPrincipalId,
                queueMembership,
                adminReadModels,
                cancellationToken).ConfigureAwait(false));

        CommentModerationFixtureResult result = new(
            ResultSchema,
            plan.Binding,
            BuildRuntimeSemantics(entities),
            entities);
        return result with
        {
            ContentDigest = Digest(JsonSerializer.Serialize(new
            {
                result.Schema,
                result.Binding,
                result.RuntimeSemantics,
                result.Entities
            }))
        };
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
        IReadOnlyDictionary<CommentModerationStatus, QueueSnapshot> queues,
        IReadOnlyDictionary<CommentModerationStatus, QueueSnapshot> adminReadModels,
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

        List<CommentRegionCompliance> regionRows = await db.Queryable<CommentRegionCompliance>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (regionRows.Count > 1)
            throw new InvalidOperationException($"Comment region evidence is duplicated for {operation.SemanticRole}.");
        CommentRegionCompliance? region = regionRows.SingleOrDefault();
        List<CommentBlockedRegion> blocked = await db.Queryable<CommentBlockedRegion>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.RegionCode, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (blocked.Select(item => item.RegionCode).Distinct(StringComparer.Ordinal).Count() != blocked.Count)
            throw new InvalidOperationException($"Comment blocked-region evidence is duplicated for {operation.SemanticRole}.");
        List<CommentModerationSignal> signals = await db.Queryable<CommentModerationSignal>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (signals.Count > 1)
            throw new InvalidOperationException($"Comment moderation signal evidence is duplicated for {operation.SemanticRole}.");
        List<CommentModerationEvent> events = await db.Queryable<CommentModerationEvent>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        List<CommentMutationOutboxEvent> outbox = await db.Queryable<CommentMutationOutboxEvent>()
            .Where(item => item.CommentId == row.Id)
            .OrderBy(item => item.Id, OrderByType.Asc)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

        if (operation.RequireRegionEvidence && (region is null || string.IsNullOrWhiteSpace(region.PolicyVersion)
            || string.IsNullOrWhiteSpace(region.RegionProvider) || string.IsNullOrWhiteSpace(region.DecisionReason)
            || string.IsNullOrWhiteSpace(region.SubmitRegion) || !double.IsFinite(region.SubmitRegionConfidence)
            || region.SubmitRegionConfidence is < 0d or > 1d
            || !HasValidRuleHitsEvidence(region.RuleHitsJson)))
            throw new InvalidOperationException($"Region evidence is missing for {operation.SemanticRole}.");
        if (operation.RequireSignalEvidence && (signals.Count != 1
            || signals.Any(item => string.IsNullOrWhiteSpace(item.EvidenceJson)
                || string.IsNullOrWhiteSpace(item.Provider) || string.IsNullOrWhiteSpace(item.ContractVersion)
                || string.IsNullOrWhiteSpace(item.Model) || string.IsNullOrWhiteSpace(item.Label)
                || !StringComparer.Ordinal.Equals(item.Status, AntiSpamModerationStatuses.Ok)
                || !double.IsFinite(item.Confidence) || item.Confidence is < 0d or > 1d
                || !HasStructuredEvidence(item.EvidenceJson))))
            throw new InvalidOperationException($"Signal evidence is missing for {operation.SemanticRole}.");
        if (events.Count == 0 || outbox.Count == 0
            || outbox.Any(item => !Guid.TryParseExact(item.EventId, "D", out _)
                || !StringComparer.Ordinal.Equals(item.Status, CommentMutationOutboxStatus.Processed))
            || events.All(item => item.NextStatus != expectedRuntime))
            throw new InvalidOperationException($"Moderation audit/outbox evidence is missing for {operation.SemanticRole}.");

        bool requiresAdminActor = !initialPending
            && !(regionObservation && expectedRuntime == CommentModerationStatus.Pending);
        if (requiresAdminActor && (row.ModeratedByAdminPrincipalId != adminPrincipalId || row.ModeratedAt is null
            || events.All(item => item.AdminPrincipalId != adminPrincipalId
                || !StringComparer.Ordinal.Equals(item.ActorType, "admin"))))
            throw new InvalidOperationException($"Admin moderation actor evidence is missing for {operation.SemanticRole}.");

        CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(row.ArticleId, row.Id)
            .ConfigureAwait(false);
        bool publiclyVisible = publicProjection.Status == "found";
        if (publiclyVisible != (expectedRuntime == CommentModerationStatus.Approved))
            throw new InvalidOperationException($"Public moderation projection drifted for {operation.SemanticRole}.");

        string commentId = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string cacheIdentity = $"article:{row.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
        string cacheGeneration = await ReadCommentCacheGenerationAsync(row.ArticleId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Comment {row.Id} has no readable cache generation.");
        if (!IsCacheGeneration(cacheGeneration))
            throw new InvalidOperationException($"Comment {row.Id} cache generation is invalid.");
        QueueSnapshot queueSnapshot = queues[expectedRuntime];
        QueueSnapshot adminSnapshot = adminReadModels[expectedRuntime];
        CommentModerationItemResponse? queueItem = FindExactItem(queueSnapshot, commentId);
        CommentModerationItemResponse? adminItem = FindExactItem(adminSnapshot, commentId);
        if (adminItem is null || adminItem.Status != expectedRuntime
            || adminItem.ModeratedByAdminPrincipalId != row.ModeratedByAdminPrincipalId
            || adminItem.ModeratedAt != row.ModeratedAt
            || !StringComparer.Ordinal.Equals(adminItem.Reason, row.ModerationReason)
            || string.IsNullOrWhiteSpace(adminItem.ModerationActor))
            throw new InvalidOperationException($"Admin moderation read model is incomplete for {operation.SemanticRole}.");

        int queueOrder = queueItem is null
            ? -1
            : queueSnapshot.Items.ToList().FindIndex(item => item.Id == commentId);
        bool queueMember = queueItem is not null;
        bool expectedQueueMember = expectedRuntime is CommentModerationStatus.Pending or CommentModerationStatus.Rejected;
        if (queueMember != expectedQueueMember
            || (queueItem is not null && (queueItem.Status != expectedRuntime
                || queueItem.ModeratedByAdminPrincipalId != row.ModeratedByAdminPrincipalId
                || queueItem.ModeratedAt != row.ModeratedAt
                || !StringComparer.Ordinal.Equals(queueItem.Reason, row.ModerationReason)
                || string.IsNullOrWhiteSpace(queueItem.ModerationActor))))
            throw new InvalidOperationException($"Queue membership drifted for {operation.SemanticRole}.");
        var regionEvidence = new List<CommentRegionFixtureEvidence>();
        if (region is not null)
            regionEvidence.Add(new CommentRegionFixtureEvidence(
                row.Id,
                "comment_region_compliance",
                region.SubmitRegion,
                region.PolicyVersion,
                Digest(JsonSerializer.Serialize(new
                {
                    region.CommentId,
                    region.SubmitRegion,
                    region.SubmitRegionConfidence,
                    region.RegionProvider,
                    region.PolicyVersion,
                    region.CanPublish,
                    region.RequiresManualReview,
                    region.HideUntilReviewed,
                    region.DecisionReason,
                    blockedRegions = RegionLegalModerationService.DeserializeRegions(region.BlockedRegions),
                    ruleHitsDigest = Digest(region.RuleHitsJson ?? string.Empty)
                })))
            {
                Provider = region.RegionProvider,
                CanPublish = region.CanPublish,
                RequiresManualReview = region.RequiresManualReview,
                HideUntilReviewed = region.HideUntilReviewed,
                DecisionReason = region.DecisionReason ?? string.Empty,
                BlockedRegions = RegionLegalModerationService.DeserializeRegions(region.BlockedRegions),
                ApplicableRegions = BuildApplicableRegions(region)
            });
        regionEvidence.AddRange(blocked.Select(item =>
            new CommentRegionFixtureEvidence(
                row.Id,
                "comment_blocked_region",
                item.RegionCode,
                region?.PolicyVersion ?? string.Empty,
                Digest(JsonSerializer.Serialize(new
                {
                    item.CommentId,
                    item.RegionCode,
                    policyVersion = region?.PolicyVersion,
                    provider = region?.RegionProvider,
                    decisionReason = region?.DecisionReason,
                    ruleHitsDigest = Digest(region?.RuleHitsJson ?? string.Empty)
                })))
            {
                Provider = region?.RegionProvider ?? string.Empty,
                CanPublish = region?.CanPublish ?? false,
                RequiresManualReview = region?.RequiresManualReview ?? false,
                HideUntilReviewed = region?.HideUntilReviewed ?? false,
                DecisionReason = region?.DecisionReason ?? string.Empty,
                BlockedRegions = RegionLegalModerationService.DeserializeRegions(region?.BlockedRegions),
                ApplicableRegions = [item.RegionCode]
            }));
        CommentSignalFixtureEvidence[] signalEvidence = [.. signals.Select(item =>
            BuildSignalEvidence(item, operation.RequireSignalEvidence))];

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
            queueSnapshot.Items.Count,
            region?.SubmitRegion,
            region?.PolicyVersion,
            region?.RequiresManualReview,
            regionEvidence,
            signalEvidence,
            [.. events.Select(item => item.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))],
            [.. outbox.Select(item => item.EventId)])
        {
            AdminVisible = true,
            AdminStatus = adminItem.Status.ToString().ToLowerInvariant(),
            AdminModerationActor = adminItem.ModerationActor,
            QueueGroup = expectedRuntime.ToString().ToLowerInvariant(),
            QueueReason = (queueItem ?? adminItem).Reason,
            QueueActor = (queueItem ?? adminItem).ModerationActor,
            CommentReferenceDigest = operation.CommentReferenceDigest,
            ReasonId = operation.ReasonId,
            RegionStateId = operation.RegionStateId,
            SignalStateId = operation.SignalStateId,
            ApplicableRegions = BuildApplicableRegions(region),
            ArticleId = row.ArticleId,
            CacheIdentity = cacheIdentity,
            CacheGeneration = cacheGeneration
        };
    }

    private static IReadOnlyList<string> BuildApplicableRegions(CommentRegionCompliance? region)
        => region is null
            ? []
            : new[] { region.SubmitRegion }
                .Concat(RegionLegalModerationService.DeserializeRegions(region.BlockedRegions))
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray();

    private async Task DrainOutboxAsync(
        IReadOnlyList<CommentModerationFixtureOperation> operations,
        CancellationToken cancellationToken)
    {
        long[] commentIds = [.. operations.Select(static item => item.CommentId).Distinct()];
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

    private async Task<QueueSnapshot> ReadExactQueueAsync(
        CommentModerationStatus? status,
        CancellationToken cancellationToken)
    {
        var items = new List<CommentModerationItemResponse>();
        var seenCursors = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null;
        do
        {
            CommentModerationQueueResponse page = await queue.ListCommentModerationQueuePageAsync(
                status, 100, cursor, cancellationToken).ConfigureAwait(false);
            items.AddRange(page.Items);
            cursor = page.NextCursor;
            if (cursor is not null && !seenCursors.Add(cursor))
                throw new InvalidOperationException($"Moderation queue {status} returned a repeated cursor.");
        }
        while (cursor is not null);
        if (items.Any(item => string.IsNullOrWhiteSpace(item.Id))
            || items.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() != items.Count)
            throw new InvalidOperationException($"Moderation queue {status} contains duplicate identities.");
        return new QueueSnapshot(status, items);
    }

    private sealed record QueueSnapshot(
        CommentModerationStatus? Filter,
        IReadOnlyList<CommentModerationItemResponse> Items);

    private static CommentModerationItemResponse? FindExactItem(QueueSnapshot snapshot, string commentId)
    {
        CommentModerationItemResponse[] matches = [.. snapshot.Items.Where(item =>
            StringComparer.Ordinal.Equals(item.Id, commentId))];
        if (matches.Length > 1)
            throw new InvalidOperationException($"Moderation read model {snapshot.Filter} duplicated comment {commentId}.");
        return matches.SingleOrDefault();
    }

    private static CommentSignalFixtureEvidence BuildSignalEvidence(
        CommentModerationSignal signal,
        bool requireStructuredEvidence)
    {
        bool hasStructuredEvidence = HasStructuredEvidence(signal.EvidenceJson);
        if (requireStructuredEvidence && !hasStructuredEvidence)
            throw new InvalidOperationException($"Signal {signal.Id} has no structured evidence.");
        // Low-risk signals may intentionally have no raw evidence payload. Keep
        // those signals observable without inventing a raw evidence document: the
        // digest is a typed projection of the persisted signal columns. Required
        // signals (the spam fixture) still fail closed unless raw structured
        // evidence was persisted by the production scorer.
        string evidenceDigest = hasStructuredEvidence
            ? Digest(signal.EvidenceJson!)
            : Digest(JsonSerializer.Serialize(new
            {
                signal.CommentId,
                signal.Provider,
                signal.Model,
                signal.ContractVersion,
                signal.Label,
                signal.Severity,
                signal.Confidence,
                signal.PrimaryReason,
                signal.NeedsSecondRound,
                signal.RiskCategories,
                signal.Status,
                signal.ThresholdProfile
            }));
        return new CommentSignalFixtureEvidence(
            signal.Id,
            signal.CommentId,
            signal.Provider,
            signal.ContractVersion,
            signal.Label,
            signal.Confidence,
            evidenceDigest)
        {
            Source = ResolveSignalSource(signal),
            Model = signal.Model,
            Status = signal.Status,
            Score = signal.Confidence,
            EvidenceRefs = [evidenceDigest]
        };
    }

    private static string ResolveSignalSource(CommentModerationSignal signal)
    {
        if (!string.IsNullOrWhiteSpace(signal.MetadataJson))
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(signal.MetadataJson);
                if (document.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (string key in new[] { "runtime_source", "source" })
                    {
                        if (document.RootElement.TryGetProperty(key, out JsonElement value)
                            && value.ValueKind == JsonValueKind.String
                            && !string.IsNullOrWhiteSpace(value.GetString()))
                            return value.GetString()!.Trim();
                    }
                }
            }
            catch (JsonException)
            {
                throw new InvalidOperationException($"Signal {signal.Id} metadata is not valid JSON.");
            }
        }
        throw new InvalidOperationException($"Signal {signal.Id} has no explicit source metadata.");
    }

    private static bool HasValidRuleHitsEvidence(string? ruleHitsJson)
    {
        if (string.IsNullOrWhiteSpace(ruleHitsJson))
            return true;
        try
        {
            using JsonDocument document = JsonDocument.Parse(ruleHitsJson);
            return document.RootElement.ValueKind is JsonValueKind.Array or JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool HasStructuredEvidence(string? evidenceJson)
    {
        if (string.IsNullOrWhiteSpace(evidenceJson))
            return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(evidenceJson);
            if (document.RootElement.ValueKind != JsonValueKind.Array
                || document.RootElement.GetArrayLength() == 0)
                return false;
            foreach (JsonElement evidence in document.RootElement.EnumerateArray())
            {
                if (evidence.ValueKind != JsonValueKind.Object
                    || !evidence.TryGetProperty("category", out JsonElement category)
                    || category.ValueKind != JsonValueKind.String
                    || string.IsNullOrWhiteSpace(category.GetString())
                    || !evidence.TryGetProperty("policy", out JsonElement policy)
                    || policy.ValueKind != JsonValueKind.String
                    || string.IsNullOrWhiteSpace(policy.GetString()))
                    return false;
            }
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static CommentFixtureRuntimeSemantics BuildRuntimeSemantics(
        IReadOnlyList<CommentModerationFixtureEntity> entities)
    {
        string[] statuses = ["approved", "pending", "rejected", "spam"];
        var visibility = new Dictionary<string, string>(StringComparer.Ordinal);
        var queues = new Dictionary<string, string>(StringComparer.Ordinal);
        var adminVisibility = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string status in statuses)
        {
            CommentModerationFixtureEntity entity = entities.Single(item =>
                item.CapabilityId == $"comment.moderation.{status}");
            visibility[status] = entity.PubliclyVisible ? "visible-exact" : "hidden-exact";
            adminVisibility[status] = entity.AdminVisible ? "visible-exact" : "hidden-exact";
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
            "production-comment-query-and-authoring-moderation-queue")
        {
            AdminVisibility = adminVisibility
        };
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
            || plan.AdminPrincipalId <= 0 || !IsDigest(plan.AdminActorReferenceDigest)
            || !plan.Binding.AuthPrepareReferenceDigests.Contains(
                plan.AdminActorReferenceDigest,
                StringComparer.Ordinal)
            || plan.Operations.Count == 0)
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
            || plan.Operations.Select(item => item.SemanticRole).Distinct(StringComparer.Ordinal).Count() != plan.Operations.Count
            || plan.Operations.Any(item => !IsDigest(item.CommentReferenceDigest)))
            throw new InvalidOperationException("Moderation fixture states must use independent comment identities.");

        var expectedReasonIds = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["comment.moderation.approved"] = "approved-none",
            ["comment.moderation.pending"] = "pending-none",
            ["comment.moderation.rejected"] = "rejected-fixture",
            ["comment.moderation.spam"] = "spam-fixture",
            ["comment.region.global"] = "approved-none",
            ["comment.region.manual-review"] = "pending-none"
        };
        var expectedReasons = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["comment.moderation.approved"] = string.Empty,
            ["comment.moderation.pending"] = string.Empty,
            ["comment.moderation.rejected"] = "fixture_rejected",
            ["comment.moderation.spam"] = "fixture_spam",
            ["comment.region.global"] = string.Empty,
            ["comment.region.manual-review"] = string.Empty
        };
        if (plan.Operations.Any(item => item.ReasonId != expectedReasonIds[item.CapabilityId]
            || item.Reason != expectedReasons[item.CapabilityId]
            || (item.CapabilityId == "comment.moderation.spam"
                ? item.SignalStateId != "verified"
                : item.SignalStateId is not null)))
            throw new InvalidOperationException("Moderation fixture reason/signal semantic references drifted.");

        CommentModerationFixtureOperation global = plan.Operations.Single(item => item.CapabilityId == "comment.region.global");
        CommentModerationFixtureOperation manual = plan.Operations.Single(item => item.CapabilityId == "comment.region.manual-review");
        if (global.RegionStateId != "global"
            || manual.RegionStateId != "manual-review"
            || plan.Operations.Any(item => item.CapabilityId.StartsWith("comment.region.", StringComparison.Ordinal)
                ? item.RegionStateId is null
                : item.RegionStateId is not null))
            throw new InvalidOperationException("Moderation fixture region semantic references drifted.");
    }

    private static bool IsDigest(string value) => value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.Length == 71 && value.AsSpan(7).IndexOfAnyExcept(s_myChars) < 0;

    private static bool IsCacheGeneration(string value)
        => ulong.TryParse(
            value,
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out _);

    private static string Digest(string value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))}";
}
