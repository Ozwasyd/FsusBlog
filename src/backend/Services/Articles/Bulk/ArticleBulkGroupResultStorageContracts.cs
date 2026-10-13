using System.Collections.Immutable;
using System.Globalization;

namespace FsusBlog.Server.Services.Articles.Bulk;

/// <summary>Exact original admission/frozen-set identity. Storage binding is not permission or transaction admission.</summary>
internal sealed record ArticleBulkGroupResultBinding(
    string GroupIdempotencyKey, ArticleBulkExecutionRequest Request,
    ImmutableArray<ArticleBulkPlanItem> FrozenItems, string ContentDigest);

/// <summary>Coordinates copied from an actual original writer result; no private body or outbox payload is persisted here.</summary>
internal sealed record ArticleBulkStoredCommandReference(
    string ArticleId, string ItemReceiptDigest, string CanonicalCommandReceiptDigest,
    string TransitionId, string RevisionContentDigest, string OutboxEventId,
    string AuditChainId, string AuditRecordHash);

/// <summary>
/// Immutable original owner-reported result, staged in its actual transaction. Persistence and
/// row visibility alone do not certify commit, rollback, zero writes or completed side effects.
/// </summary>
internal sealed record ArticleBulkOriginalGroupResult(
    string Schema, ArticleBulkGroupResultBinding Binding, ArticleBulkGroupCommitOutcome OriginalOutcome,
    string? GroupReceiptDigest, string? ZeroWriteProofDigest,
    ImmutableArray<ArticleBulkItemReceipt> ItemReceipts,
    ImmutableArray<ArticleBulkStoredCommandReference> Commands,
    DateTimeOffset RecordedAtUtc, string ContentDigest);

/// <summary>Append-only original-authority observation. It never replaces the original unknown outcome.</summary>
internal sealed record ArticleBulkStoredRecoveryObservation(
    string Schema, Guid ObservationId, long Ordinal, string OriginalResultDigest,
    string PreviousObservationDigest, ArticleBulkGroupRecoveryObservationFacts Facts,
    DateTimeOffset ObservedAtUtc, string ContentDigest);

/// <summary>Supplied canonical recovery facts; sealing this shape is not verification of the authority's business observation.</summary>
internal sealed record ArticleBulkGroupRecoveryObservationFacts(
    string ExecutionIdentityDigest, string PlanDigest, string FrozenSetDigest,
    ArticleBulkGroupCommitOutcome ObservedOutcome, string? GroupReceiptDigest, string? ZeroWriteProofDigest,
    string AuthorityObservationDigest, ImmutableArray<ArticleBulkItemReceipt> ItemReceipts);

/// <summary>Storage data only. The original execution authority must independently validate every recovered outcome.</summary>
internal sealed record ArticleBulkGroupResultStorageObservation(ArticleBulkOriginalGroupResult Original);

internal static class ArticleBulkGroupResultStorageContract
{
    internal const string ResultSchema = "fsusblog.article-bulk.original-group-result-storage.v1";
    internal const string ObservationSchema = "fsusblog.article-bulk.group-recovery-observation-storage.v1";
    internal const int MaxPayloadBytes = 16 * 1024 * 1024;
    internal const int MaxItems = 10_000;
    internal const long MaxObservationOrdinal = 32_768;
    internal const int ObservationReadBatchSize = 64;

    internal static ArticleBulkGroupResultBinding CaptureBinding(
        ArticleBulkExecutionRequest request, ArticleBulkPlan plan, string groupIdempotencyKey,
        ArticleBulkPlanAuthority plans)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(plan);
        plans.ValidateIntegrity(plan);
        string expectedExecution = ArticleBulkDigest.Of(new
        {
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.ParametersDigest,
            plan.FrozenSetDigest,
            ConfirmationDigest = request.ConfirmationDigest,
            actor = request.Actor,
            source = request.Source,
            policyDigest = request.PolicyDigest,
            permissionPolicyDigest = request.PermissionPolicyDigest
        });
        if (request.Strategy != ArticleBulkExecutionStrategy.AllOrNothing || plan.Strategy != request.Strategy
            || request.PlanDigest != plan.ContentDigest || request.RegistryDigest != plan.RegistryDigest
            || request.OperationId != plan.OperationId || request.ParametersDigest != plan.ParametersDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest || request.Actor != plan.Actor || request.Source != plan.Source
            || request.PolicyDigest != plan.PolicyDigest || request.PermissionPolicyDigest != plan.PermissionPolicyDigest
            || request.ExecutionIdentityDigest != expectedExecution || !IsDigest(groupIdempotencyKey)
            || request.ContentDigest != ArticleBulkDigest.Of(request with
            {
                ContentDigest = string.Empty
            })
            || !IsDigest(request.AdmissionAuthorityReceiptDigest))
            throw new ArticleBulkContractException("article-bulk.result-binding-invalid");
        var binding = new ArticleBulkGroupResultBinding(groupIdempotencyKey, request, [.. plan.Items], string.Empty);
        return binding with
        {
            ContentDigest = ArticleBulkDigest.Of(binding)
        };
    }

    internal static ArticleBulkStoredCommandReference CaptureCommand(
        ArticleBulkItemReceipt item, ArticleLifecycleTransitionWriter.Result actual)
    {
        if (actual.ArticleId.ToString(CultureInfo.InvariantCulture) != item.ArticleId
            || actual.Outbox.AggregateId != actual.ArticleId
            || item.ContentDigest != ArticleBulkExecutionFramework.SealItemReceipt(item).ContentDigest
            || !IsHex(actual.ContentDigest, 64) || !IsHex(actual.AuditRecordHash, 64)
            || !Guid.TryParse(actual.Outbox.EventId, out Guid eventId) || eventId == Guid.Empty)
            throw new ArticleBulkContractException("article-bulk.result-command-reference-invalid");
        return new(item.ArticleId, item.ContentDigest, item.CanonicalCommandReceiptDigest,
            actual.TransitionId, actual.ContentDigest, actual.Outbox.EventId, actual.AuditChainId, actual.AuditRecordHash);
    }

    internal static void ValidateBinding(ArticleBulkGroupResultBinding binding)
    {
        ArticleBulkExecutionRequest request = binding.Request;
        if (!IsDigest(binding.GroupIdempotencyKey) || !IsDigest(binding.ContentDigest)
            || binding.ContentDigest != ArticleBulkDigest.Of(binding with
            {
                ContentDigest = string.Empty
            })
            || binding.FrozenItems.IsDefault || binding.FrozenItems.Length is < 1 or > MaxItems
            || binding.FrozenItems.Select(static item => item.ArticleId).Distinct(StringComparer.Ordinal).Count() != binding.FrozenItems.Length
            || request.ContentDigest != ArticleBulkDigest.Of(request with
            {
                ContentDigest = string.Empty
            })
            || request.Strategy != ArticleBulkExecutionStrategy.AllOrNothing
            || request.FrozenSetDigest != ArticleBulkDigest.Of(binding.FrozenItems.Select(static item => item.ArticleId).ToArray())
            || !IsText(request.Actor.UserId, 256) || !IsText(request.Actor.SiteId, 256)
            || !IsText(request.OperationId, 128) || !IsText(request.PlanReference, 1024)
            || !IsText(request.AttemptId, 256) || !IsText(request.IdempotencyKey, 256)
            || !IsHex(request.Source.Commit, 40)
            || new[] { request.ExecutionIdentityDigest, request.ContentDigest, request.PlanDigest,
                request.RegistryDigest, request.ParametersDigest, request.FrozenSetDigest, request.ConfirmationDigest,
                request.AdmissionAuthorityReceiptDigest, request.Actor.AuthorityDigest, request.Source.BuildDigest,
                request.PolicyDigest, request.PermissionPolicyDigest }.Any(static digest => !IsDigest(digest))
            || binding.FrozenItems.Any(static item => item.ContentDigest != ArticleBulkDigest.Of(item with { ContentDigest = string.Empty })))
            throw new ArticleBulkContractException("article-bulk.result-binding-tampered");
    }

    internal static void ValidateResult(ArticleBulkOriginalGroupResult value)
    {
        ValidateBinding(value.Binding);
        if (value.Schema != ResultSchema || value.RecordedAtUtc.Offset != TimeSpan.Zero || !Enum.IsDefined(value.OriginalOutcome)
            || value.ContentDigest != ArticleBulkDigest.Of(value with
            {
                ContentDigest = string.Empty
            })
            || value.ItemReceipts.IsDefault || value.Commands.IsDefault
            || value.ItemReceipts.Length > value.Binding.FrozenItems.Length || value.Commands.Length > value.ItemReceipts.Length)
            throw new ArticleBulkContractException("article-bulk.original-result-invalid");
        ValidateReportedOutcome(value.OriginalOutcome, value.GroupReceiptDigest, value.ZeroWriteProofDigest);
        ValidateItems(value.Binding, value.ItemReceipts);
        if (value.Commands.Select(static item => item.ArticleId).Distinct(StringComparer.Ordinal).Count() != value.Commands.Length)
            throw new ArticleBulkContractException("article-bulk.result-command-duplicate");
        var items = value.ItemReceipts.ToDictionary(static item => item.ArticleId, StringComparer.Ordinal);
        foreach (ArticleBulkStoredCommandReference command in value.Commands)
        {
            if (!items.TryGetValue(command.ArticleId, out ArticleBulkItemReceipt? item) || item.ContentDigest != command.ItemReceiptDigest
                || item.CanonicalCommandReceiptDigest != command.CanonicalCommandReceiptDigest
                || !IsText(command.TransitionId, 256) || !IsText(command.AuditChainId, 32)
                || !IsHex(command.RevisionContentDigest, 64) || !IsHex(command.AuditRecordHash, 64)
                || !Guid.TryParse(command.OutboxEventId, out Guid eventId) || eventId == Guid.Empty)
                throw new ArticleBulkContractException("article-bulk.result-command-unbound");
        }
        if (value.OriginalOutcome == ArticleBulkGroupCommitOutcome.Committed
            && (value.Commands.Length != value.Binding.FrozenItems.Length || value.ItemReceipts.Length != value.Commands.Length)
            || value.OriginalOutcome is ArticleBulkGroupCommitOutcome.RejectedZeroWrite or ArticleBulkGroupCommitOutcome.FailedZeroWrite
                && value.Commands.Length != 0)
            throw new ArticleBulkContractException("article-bulk.result-command-set-incomplete");
    }

    internal static void ValidateObservation(ArticleBulkOriginalGroupResult original, ArticleBulkStoredRecoveryObservation value)
    {
        if (value.Schema != ObservationSchema || value.ObservationId == Guid.Empty
            || value.Ordinal is < 1 or > MaxObservationOrdinal || value.ObservedAtUtc.Offset != TimeSpan.Zero
            || value.OriginalResultDigest != original.ContentDigest || !IsDigest(value.PreviousObservationDigest)
            || value.ContentDigest != ArticleBulkDigest.Of(value with
            {
                ContentDigest = string.Empty
            })
            || value.Facts.ExecutionIdentityDigest != original.Binding.Request.ExecutionIdentityDigest
            || value.Facts.PlanDigest != original.Binding.Request.PlanDigest
            || value.Facts.FrozenSetDigest != original.Binding.Request.FrozenSetDigest
            || !IsDigest(value.Facts.AuthorityObservationDigest))
            throw new ArticleBulkContractException("article-bulk.result-observation-invalid");
        ValidateReportedOutcome(value.Facts.ObservedOutcome, value.Facts.GroupReceiptDigest, value.Facts.ZeroWriteProofDigest);
        ValidateItems(original.Binding, value.Facts.ItemReceipts);
    }

    private static void ValidateItems(ArticleBulkGroupResultBinding binding, ImmutableArray<ArticleBulkItemReceipt> items)
    {
        if (items.IsDefault || items.Length > binding.FrozenItems.Length
            || items.Select(static item => item.ArticleId).Distinct(StringComparer.Ordinal).Count() != items.Length)
            throw new ArticleBulkContractException("article-bulk.result-items-invalid");
        var frozen = binding.FrozenItems.ToDictionary(static item => item.ArticleId, StringComparer.Ordinal);
        foreach (ArticleBulkItemReceipt item in items)
        {
            if (!frozen.TryGetValue(item.ArticleId, out ArticleBulkPlanItem? expected)
                || item.AttemptId != binding.Request.AttemptId || item.PlanDigest != binding.Request.PlanDigest
                || item.RegistryDigest != binding.Request.RegistryDigest || item.OperationId != binding.Request.OperationId
                || item.ExpectedRevision != expected.ExpectedRevision
                || item.ContentDigest != ArticleBulkExecutionFramework.SealItemReceipt(item).ContentDigest)
                throw new ArticleBulkContractException("article-bulk.result-item-unbound");
        }
    }

    private static void ValidateReportedOutcome(ArticleBulkGroupCommitOutcome outcome, string? group, string? zero)
    {
        bool valid = outcome switch
        {
            ArticleBulkGroupCommitOutcome.Committed => IsDigest(group) && zero is null,
            ArticleBulkGroupCommitOutcome.RejectedZeroWrite or ArticleBulkGroupCommitOutcome.FailedZeroWrite => group is null && IsDigest(zero),
            ArticleBulkGroupCommitOutcome.UnknownRecovery => group is null && zero is null,
            _ => false
        };
        if (!valid)
            throw new ArticleBulkContractException("article-bulk.result-reported-outcome-invalid");
    }

    private static bool IsDigest(string? value)
        => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal) && IsHex(value[7..], 64);

    private static bool IsHex(string? value, int length)
        => value is not null && value.Length == length && value.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsText(string? value, int max)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= max && value == value.Trim() && !value.Any(char.IsControl);
}
