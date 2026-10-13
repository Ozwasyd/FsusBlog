using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

public static class ArticleVaultExecutionIntegrity
{
    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    public static string SealPayloadItem(ArticleVaultExecutionPayloadItem item)
        => Digest(item with
        {
            ContentSha256 = string.Empty
        });

    public static string SealPayload(ArticleVaultExecutionPayload payload)
        => Digest(payload with
        {
            ContentSha256 = string.Empty
        });

    public static string SealBundle(ArticleVaultSealedExecutionBundle bundle)
        => Digest(bundle with
        {
            ContentSha256 = string.Empty
        });

    public static string SealCanonicalCommand(ArticleVaultCanonicalMutationCommand command)
        => Digest(command with
        {
            ContentSha256 = string.Empty
        });

    public static string SealCanonicalReceipt(ArticleVaultCanonicalMutationReceipt receipt)
        => Digest(receipt with
        {
            ContentSha256 = string.Empty
        });

    public static string SealOperationReceipt(ArticleVaultOperationResultReceipt receipt)
        => Digest(receipt with
        {
            ContentSha256 = string.Empty
        });

    public static string SealGroupReceipt(ArticleVaultGroupResultReceipt receipt)
        => Digest(receipt with
        {
            ContentSha256 = string.Empty
        });

    public static string SealResult(ArticleVaultExecutionResult result)
        => Digest(result with
        {
            ContentSha256 = string.Empty
        });

    public static string ComputeGroupIdempotency(
        ArticleVaultSyncPlan plan,
        VaultSyncPlanGroup group)
        => Digest(new
        {
            plan.SiteIdentity,
            plan.VaultIdentity,
            plan.IdempotencyKey,
            PlanSha256 = plan.ContentSha256,
            group.GroupIdentity,
            Operations = group.Items.Select(static item => item.OperationIdentity).ToArray()
        });

    public static string ComputeDependencyOutcome(
        string operationIdentity,
        ArticleVaultOperationOutcome outcome,
        string receiptSha256)
        => Digest(new
        {
            operationIdentity,
            outcome,
            receiptSha256
        });

    public static void ValidateBundle(ArticleVaultSealedExecutionBundle? bundle)
    {
        if (bundle is null
            || bundle.Schema != ArticleVaultExecutionSchemas.Bundle
            || bundle.SchemaVersion != ArticleVaultExecutionSchemas.Version
            || bundle.AdminPrincipalId <= 0
            || !IsOpaque(bundle.PlanReference, 256)
            || !IsDigest(bundle.PlanSha256)
            || bundle.PlanSha256 != bundle.Plan.ContentSha256
            || bundle.PlanReference != bundle.Plan.PlanCandidateIdentity
            || bundle.ContentSha256 != SealBundle(bundle))
        {
            throw Rejected("article_vault_execution_bundle_invalid");
        }

        ArticleVaultValidationResult plan = ArticleVaultSyncPlanVerifier.ValidateStructure(bundle.Plan);
        if (!plan.IsValid)
        {
            throw Rejected(plan.ReasonCode ?? "article_vault_plan_invalid");
        }

        if (bundle.Payload.Schema != ArticleVaultExecutionSchemas.Payload
            || bundle.Payload.SchemaVersion != ArticleVaultExecutionSchemas.Version
            || bundle.Payload.Items is null
            || bundle.Payload.ContentSha256 != SealPayload(bundle.Payload))
        {
            throw Rejected("article_vault_execution_payload_invalid");
        }

        Dictionary<string, VaultSyncPlanItem> planItems = bundle.Plan.Groups
            .SelectMany(static group => group.Items)
            .ToDictionary(static item => item.OperationIdentity, StringComparer.Ordinal);
        var payloadOperations = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleVaultExecutionPayloadItem item in bundle.Payload.Items)
        {
            if (!payloadOperations.Add(item.OperationIdentity)
                || item.ContentSha256 != SealPayloadItem(item)
                || !planItems.TryGetValue(item.OperationIdentity, out VaultSyncPlanItem? planned)
                || item.PortableArticleIdentity != planned.PortableArticleIdentity
                || item.ServerArticleIdentity != planned.ServerArticleIdentity
                || item.SourceSha256 != planned.Local.Source?.Sha256
                || item.MetadataManifestSha256 != planned.Local.MetadataManifestSha256
                || ArticleVaultManifestValidator.ValidateSourceBytes(
                    planned.Local.Source,
                    Encoding.UTF8.GetBytes(item.Content)) is not { IsValid: true }
                || item.CategoryId <= 0
                || item.TagIds is null
                || item.TagIds.Count > 32
                || item.TagIds.Any(static id => id <= 0)
                || item.TagIds.Distinct().Count() != item.TagIds.Count)
            {
                throw Rejected("article_vault_execution_payload_binding_invalid");
            }
        }

        string[] requiredPayloadOperations = planItems.Values
            .Where(static item => item.Decision is VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate)
            .Select(static item => item.OperationIdentity)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!payloadOperations.Order(StringComparer.Ordinal).SequenceEqual(requiredPayloadOperations, StringComparer.Ordinal))
        {
            throw Rejected("article_vault_execution_payload_membership_mismatch");
        }

        ArticleVaultValidationResult sealedInputs = ArticleVaultSyncPlanVerifier.VerifyCurrent(
            bundle.Plan,
            bundle.RootManifest,
            bundle.ArticleManifests,
            bundle.PlannedObservations,
            new ArticleVaultPlanVerificationContext(
                bundle.Plan.CreatedAtUnixMs,
                bundle.Plan.Direction,
                bundle.Plan.CancellationRequested));
        if (!sealedInputs.IsValid)
        {
            throw Rejected(sealedInputs.ReasonCode ?? "article_vault_execution_bundle_drift");
        }
    }

    public static void VerifyGroupReceipt(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        ArticleVaultGroupResultReceipt receipt)
    {
        string expectedIdempotency = ComputeGroupIdempotency(bundle.Plan, group);
        if (receipt is null
            || receipt.Operations is null
            || receipt.Schema != ArticleVaultExecutionSchemas.GroupReceipt
            || receipt.SchemaVersion != ArticleVaultExecutionSchemas.Version
            || receipt.SiteIdentity != bundle.Plan.SiteIdentity
            || receipt.VaultIdentity != bundle.Plan.VaultIdentity
            || receipt.PlanSha256 != bundle.PlanSha256
            || receipt.GroupIdentity != group.GroupIdentity
            || receipt.IdempotencySha256 != expectedIdempotency
            || receipt.ContentSha256 != SealGroupReceipt(receipt)
            || receipt.Operations.Count != group.Items.Count)
        {
            throw Rejected("article_vault_group_receipt_invalid");
        }

        if (receipt.Committed != string.IsNullOrWhiteSpace(receipt.ReasonCode))
        {
            throw Rejected("article_vault_group_receipt_outcome_invalid");
        }

        Dictionary<string, ArticleVaultExecutionPayloadItem> payloadByOperation = bundle.Payload.Items
            .ToDictionary(static item => item.OperationIdentity, StringComparer.Ordinal);

        for (int index = 0; index < group.Items.Count; index++)
        {
            VaultSyncPlanItem item = group.Items[index];
            ArticleVaultOperationResultReceipt operation = receipt.Operations[index];
            if (operation is null
                || operation.DependencyOperationIdentities is null
                || operation.DependencyOutcomeSha256s is null
                || operation.Schema != ArticleVaultExecutionSchemas.OperationReceipt
                || operation.SchemaVersion != ArticleVaultExecutionSchemas.Version
                || operation.SiteIdentity != bundle.Plan.SiteIdentity
                || operation.VaultIdentity != bundle.Plan.VaultIdentity
                || operation.PlanSha256 != bundle.PlanSha256
                || operation.GroupIdentity != group.GroupIdentity
                || operation.OperationIdentity != item.OperationIdentity
                || operation.PortableArticleIdentity != item.PortableArticleIdentity
                || operation.Decision != item.Decision
                || operation.IdempotencySha256 != expectedIdempotency
                || operation.ContentSha256 != SealOperationReceipt(operation)
                || !operation.DependencyOperationIdentities.SequenceEqual(
                    item.DependsOnOperationIdentities,
                    StringComparer.Ordinal)
                || operation.DependencyOutcomeSha256s.Count != item.DependsOnOperationIdentities.Count)
            {
                throw Rejected("article_vault_operation_receipt_invalid");
            }

            var expectedDependencyOutcomes = new List<string>(item.DependsOnOperationIdentities.Count);
            foreach (string dependency in item.DependsOnOperationIdentities)
            {
                ArticleVaultOperationResultReceipt? dependencyReceipt = receipt.Operations
                    .Take(index)
                    .SingleOrDefault(candidate => candidate.OperationIdentity == dependency);
                if (dependencyReceipt is null)
                {
                    throw Rejected("article_vault_dependency_outcome_mismatch");
                }
                expectedDependencyOutcomes.Add(ComputeDependencyOutcome(
                    dependencyReceipt.OperationIdentity,
                    dependencyReceipt.Outcome,
                    dependencyReceipt.ContentSha256));
            }
            if (!operation.DependencyOutcomeSha256s.SequenceEqual(expectedDependencyOutcomes, StringComparer.Ordinal))
            {
                throw Rejected("article_vault_dependency_outcome_mismatch");
            }

            bool mutation = item.Decision is VaultSyncDecision.PushCreate
                or VaultSyncDecision.PushUpdate
                or VaultSyncDecision.PushDelete;
            bool articleIdentityMatches = item.Decision == VaultSyncDecision.PushCreate
                ? receipt.Committed
                    ? operation.ArticleId is > 0
                    : operation.ArticleId is null
                : TryParseArticleId(item.ServerArticleIdentity, out int expectedArticleId)
                    ? operation.ArticleId == expectedArticleId
                    : operation.ArticleId is null;
            if (!articleIdentityMatches
                || operation.BeforeRevision != item.Preconditions.ExpectedServerRevision)
            {
                throw Rejected("article_vault_writer_receipt_mismatch");
            }

            string? expectedArticleContent = operation.Outcome == ArticleVaultOperationOutcome.Executed
                && item.Decision is VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate
                    ? payloadByOperation[item.OperationIdentity].SourceSha256
                    : item.Server.Source?.Sha256;
            if (operation.ArticleContentSha256 != expectedArticleContent)
            {
                throw Rejected("article_vault_writer_receipt_mismatch");
            }

            if (!receipt.Committed)
            {
                if (operation.Outcome != ArticleVaultOperationOutcome.Failed
                    || operation.AfterRevision != operation.BeforeRevision
                    || operation.WriterReference != "article-service/rolled-back"
                    || operation.OutboxReference is not null
                    || operation.AuditReference is not null
                    || string.IsNullOrWhiteSpace(operation.ReasonCode))
                {
                    throw Rejected("article_vault_group_partial_result");
                }
                continue;
            }

            if (operation.Outcome == ArticleVaultOperationOutcome.Failed
                || mutation && operation.Outcome is not (
                    ArticleVaultOperationOutcome.Executed or ArticleVaultOperationOutcome.NoOp)
                || !mutation && operation.Outcome != ArticleVaultOperationOutcome.NoOp)
            {
                throw Rejected("article_vault_operation_outcome_mismatch");
            }

            bool revisionMatches = item.Decision switch
            {
                VaultSyncDecision.PushCreate => operation.Outcome == ArticleVaultOperationOutcome.Executed
                    && operation.BeforeRevision is null
                    && operation.AfterRevision is > 0,
                VaultSyncDecision.PushUpdate when operation.Outcome == ArticleVaultOperationOutcome.Executed
                    => operation.AfterRevision > operation.BeforeRevision,
                VaultSyncDecision.PushUpdate => operation.AfterRevision == operation.BeforeRevision,
                _ => operation.AfterRevision == operation.BeforeRevision
            };
            if (!revisionMatches)
            {
                throw Rejected("article_vault_writer_receipt_mismatch");
            }

            string? expectedWriterReference = mutation
                && operation.ArticleId is int writerArticleId
                && operation.AfterRevision is long writerRevisionId
                    ? $"article-service:{writerArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture)}:{writerRevisionId.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
                    : "article-service/noop";
            if (operation.WriterReference != expectedWriterReference)
            {
                throw Rejected("article_vault_writer_receipt_mismatch");
            }

            if (receipt.Committed && mutation && operation.Outcome == ArticleVaultOperationOutcome.Executed
                && (string.IsNullOrWhiteSpace(operation.WriterReference)
                    || string.IsNullOrWhiteSpace(operation.OutboxReference)
                    || !Guid.TryParse(operation.OutboxReference, out _)
                    || !IsDigest(operation.AuditReference)))
            {
                throw Rejected("article_vault_operation_side_effect_receipt_missing");
            }
            if (operation.Outcome != ArticleVaultOperationOutcome.Executed
                && (operation.OutboxReference is not null || operation.AuditReference is not null))
            {
                throw Rejected("article_vault_operation_side_effect_receipt_unexpected");
            }
        }

        if (!receipt.Committed && receipt.Operations.Any(static item => item.Outcome == ArticleVaultOperationOutcome.Executed))
        {
            throw Rejected("article_vault_group_partial_result");
        }


        ArticleVaultOperationResultReceipt[] executed = receipt.Operations
            .Where(static operation => operation.Outcome == ArticleVaultOperationOutcome.Executed)
            .ToArray();
        if (executed.Select(static operation => operation.OutboxReference).Distinct(StringComparer.Ordinal).Count()
                != executed.Length
            || executed.Select(static operation => operation.AuditReference).Distinct(StringComparer.Ordinal).Count()
                != executed.Length)
        {
            throw Rejected("article_vault_operation_side_effect_receipt_duplicate");
        }
    }

    public static void VerifyResult(ArticleVaultSealedExecutionBundle bundle, ArticleVaultExecutionResult result)
    {
        if (result is null
            || result.Groups is null
            || result.Schema != ArticleVaultExecutionSchemas.Result
            || result.SchemaVersion != ArticleVaultExecutionSchemas.Version
            || result.ResultReference != bundle.Plan.ResultCandidateIdentity
            || result.SiteIdentity != bundle.Plan.SiteIdentity
            || result.VaultIdentity != bundle.Plan.VaultIdentity
            || result.PlanReference != bundle.PlanReference
            || result.PlanSha256 != bundle.PlanSha256
            || result.IdempotencyKey != bundle.Plan.IdempotencyKey
            || result.CompletedAtUnixMs < bundle.Plan.CreatedAtUnixMs
            || result.ContentSha256 != SealResult(result)
            || result.Groups.Count > bundle.Plan.Groups.Count)
        {
            throw Rejected("article_vault_execution_result_invalid");
        }

        bool successful = result.Outcome is ArticleVaultExecutionOutcome.Completed
            or ArticleVaultExecutionOutcome.NoOp;
        if (successful != string.IsNullOrWhiteSpace(result.ReasonCode))
        {
            throw Rejected("article_vault_execution_result_outcome_mismatch");
        }

        for (int index = 0; index < result.Groups.Count; index++)
        {
            VerifyGroupReceipt(bundle, bundle.Plan.Groups[index], result.Groups[index]);
        }

        if (successful
            && result.Groups.Count != bundle.Plan.Groups.Count)
        {
            throw Rejected("article_vault_execution_result_membership_mismatch");
        }


        bool anyExecuted = result.Groups.SelectMany(static group => group.Operations)
            .Any(static operation => operation.Outcome == ArticleVaultOperationOutcome.Executed);
        if (result.Outcome == ArticleVaultExecutionOutcome.Completed && !anyExecuted
            || result.Outcome == ArticleVaultExecutionOutcome.NoOp && anyExecuted
            || successful
                && result.Groups.Any(static group => !group.Committed))
        {
            throw Rejected("article_vault_execution_result_outcome_mismatch");
        }

        if (result.Outcome == ArticleVaultExecutionOutcome.Cancelled
            && result.Groups.Any(static group => !group.Committed)
            || result.Outcome == ArticleVaultExecutionOutcome.Failed
                && result.Groups.Take(Math.Max(0, result.Groups.Count - 1)).Any(static group => !group.Committed)
            || !successful
                && result.Groups.Count == bundle.Plan.Groups.Count
                && result.Groups.All(static group => group.Committed))
        {
            throw Rejected("article_vault_execution_result_outcome_mismatch");
        }
    }

    public static bool AreTerminalResultsEquivalent(
        ArticleVaultExecutionResult left,
        ArticleVaultExecutionResult right)
        => FixedDigestEquals(
            Digest(left with
            {
                CompletedAtUnixMs = 0,
                ContentSha256 = string.Empty
            }),
            Digest(right with
            {
                CompletedAtUnixMs = 0,
                ContentSha256 = string.Empty
            }));

    public static bool FixedDigestEquals(string left, string right)
        => IsDigest(left)
            && IsDigest(right)
            && CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(left),
                Convert.FromHexString(right));

    public static string Digest<T>(T value)
        => ArticleVaultManifestCodec.ComputeSha256(Serialize(value));

    public static byte[] Serialize<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions);

    public static T Deserialize<T>(ReadOnlySpan<byte> utf8)
        => JsonSerializer.Deserialize<T>(utf8, s_jsonOptions)
            ?? throw new ArticleVaultExecutionRejectedException("article_vault_execution_payload_invalid");

    internal static bool IsDigest(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool IsOpaque(string? value, int maximumLength)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= maximumLength
            && value.All(static character => !char.IsControl(character));

    private static bool TryParseArticleId(string? value, out int articleId)
        => int.TryParse(
            value,
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out articleId)
            && articleId > 0;

    private static ArticleVaultExecutionRejectedException Rejected(string reasonCode)
        => new(reasonCode);

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            WriteIndented = false
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower, allowIntegerValues: false));
        return options;
    }
}
