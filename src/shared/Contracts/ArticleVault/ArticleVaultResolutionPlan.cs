using System.Collections.Immutable;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Separates sealed proposals from cancellation; neither grants writer admission.</summary>
public enum VaultResolutionPlanState
{
    Prepared = 1,
    Cancelled
}

/// <summary>Freezes a per-conflict closed action and its exact candidate digest.</summary>
public sealed record VaultResolutionDecision(
    VaultConflictType Type,
    VaultConflictAction Action,
    VaultConflictDisposition Provenance,
    string? ResultCandidateSha256);

/// <summary>References explicit user confirmation without storing session credentials or free text.</summary>
public sealed record VaultResolutionConfirmation(string ConfirmationIdentity, string ActorIdentity, long ConfirmedAtUnixMs);

/// <summary>Freezes an original atomic group; it cannot add members or change dependency order.</summary>
public sealed record VaultResolutionGroup(
    string GroupIdentity,
    bool AllOrNothing,
    ImmutableArray<string> PortableArticleIdentities,
    ImmutableArray<VaultPlanDependency> Dependencies);

/// <summary>References expected content only. The canonical writer alone allocates a new revision.</summary>
public sealed record VaultResolutionExpectedOutput(
    long? ExpectedServerRevision,
    string SourceSha256,
    string MetadataManifestSha256,
    string DependencySha256);

/// <summary>
/// Content-addresses a resolution proposal over exact original coordinates. It carries no source,
/// metadata values, path, command or executable payload. Existing blocked plans remain unchanged.
/// This V1 exposes scalar-metadata proposals only; source/manual/portable mapping admission is absent.
/// </summary>
public sealed record ArticleVaultResolutionPlan(
    string Schema,
    int SchemaVersion,
    string ResolutionOperationIdentity,
    VaultResolutionPlanState State,
    VaultConflictBinding Binding,
    string EvidenceSha256,
    string GitFactsSha256,
    string RootManifestSha256,
    string FieldRegistrySha256,
    ImmutableArray<VaultResolutionGroup> Groups,
    ImmutableArray<VaultResolutionDecision> Decisions,
    ImmutableArray<VaultConflictType> ActionOrder,
    VaultResolutionExpectedOutput? ExpectedOutput,
    VaultResolutionConfirmation Confirmation,
    long ExpiresAtUnixMs,
    string ContentSha256);

/// <summary>Requires actual original metadata bytes and independently recomputed candidate provenance.</summary>
public sealed record ArticleVaultResolutionPlanInput(
    ArticleVaultScalarMetadataInput Metadata,
    ArticleVaultConflictEvidence Evidence,
    ArticleVaultGitFacts Git,
    ImmutableArray<VaultResolutionDecision> Decisions,
    ArticleVaultScalarMetadataCandidate? MetadataCandidate,
    VaultResolutionConfirmation Confirmation,
    long ExpiresAtUnixMs);

/// <summary>Returns a proposal or an exact unsupported/stale boundary; never a writer command.</summary>
public sealed record ArticleVaultResolutionPlanResult(ArticleVaultResolutionPlan? Plan, string? ReasonCode);

/// <summary>
/// Seals immutable scalar proposals using the existing conflict registry, original planner and actual
/// metadata reader. Unsupported candidate kinds fail closed instead of inventing a transport proof.
/// No repository, journal, writer or materializer is accessed by this owner.
/// </summary>
public static class ArticleVaultResolutionPlanner
{
    public const string Schema = "fsusblog.article-vault.resolution-plan.v1";

    public static ArticleVaultResolutionPlanResult Build(ArticleVaultResolutionPlanInput input)
    {
        ArticleVaultValidationResult admitted = ValidateInput(input, out VaultResolutionExpectedOutput? output);
        if (!admitted.IsValid)
        {
            return new(null, admitted.ReasonCode);
        }

        bool cancelled = input.Decisions.Any(static decision => decision.Action == VaultConflictAction.CancelOperation);
        string operationDigest = Hash(new
        {
            OriginalPlan = input.Metadata.Plan.ContentSha256,
            Evidence = input.Evidence.ContentSha256,
            Git = input.Git.ContentSha256,
            input.Decisions,
            input.Confirmation,
            input.ExpiresAtUnixMs
        });
        ArticleVaultResolutionPlan plan = new(Schema, 1, "resolution-" + operationDigest,
            cancelled ? VaultResolutionPlanState.Cancelled : VaultResolutionPlanState.Prepared,
            input.Evidence.Binding, input.Evidence.ContentSha256, input.Git.ContentSha256,
            input.Metadata.Root.ContentSha256, ArticleVaultScalarMetadataMerge.FieldRegistrySha256,
            input.Metadata.Plan.Groups.Select(static group => new VaultResolutionGroup(group.GroupIdentity,
                group.AllOrNothing, group.PortableArticleIdentities.ToImmutableArray(), group.Dependencies.ToImmutableArray())).ToImmutableArray(),
            input.Decisions, input.Decisions.Select(static decision => decision.Type).ToImmutableArray(),
            cancelled ? null : output, input.Confirmation, input.ExpiresAtUnixMs, string.Empty);
        return new(plan with
        {
            ContentSha256 = ComputeContentSha256(plan)
        }, null);
    }

    /// <summary>
    /// Revalidates original current observations, bytes and Git snapshot before independently comparing
    /// every sealed field. A native Git reread and canonical admission bridge are still required at use.
    /// </summary>
    public static ArticleVaultValidationResult VerifyCurrent(ArticleVaultResolutionPlan? plan, ArticleVaultResolutionPlanInput current)
    {
        if (current is null || current.Metadata is null || current.Git is null || current.Evidence is null)
        {
            return Invalid("current_input_missing");
        }

        ArticleVaultValidationResult structure = ValidateStructure(plan);
        if (!structure.IsValid)
        {
            return structure;
        }

        if (plan!.GitFactsSha256 != current.Git.ContentSha256)
        {
            return Invalid("stale_git_facts");
        }

        if (plan.EvidenceSha256 != current.Evidence.ContentSha256)
        {
            return Invalid("stale_conflict_evidence");
        }

        if (plan.RootManifestSha256 != current.Metadata.Root.ContentSha256)
        {
            return Invalid("stale_root_manifest");
        }

        ArticleVaultValidationResult validity = ValidateInput(current, out VaultResolutionExpectedOutput? output);
        if (!validity.IsValid)
        {
            return validity;
        }

        if (!Equal(plan.Binding, current.Evidence.Binding) || !Equal(plan.Decisions, current.Decisions)
            || !Equal(plan.Confirmation, current.Confirmation) || plan.ExpiresAtUnixMs != current.ExpiresAtUnixMs)
        {
            return Invalid("stale_binding_or_decisions");
        }

        ImmutableArray<VaultResolutionGroup> groups = current.Metadata.Plan.Groups.Select(static group => new VaultResolutionGroup(
            group.GroupIdentity, group.AllOrNothing, group.PortableArticleIdentities.ToImmutableArray(),
            group.Dependencies.ToImmutableArray())).ToImmutableArray();
        bool cancelled = current.Decisions.Any(static decision => decision.Action == VaultConflictAction.CancelOperation);
        if (plan.FieldRegistrySha256 != ArticleVaultScalarMetadataMerge.FieldRegistrySha256
            || !Equal(plan.Groups, groups) || !Equal(plan.ExpectedOutput, cancelled ? null : output)
            || plan.State != (cancelled ? VaultResolutionPlanState.Cancelled : VaultResolutionPlanState.Prepared))
        {
            return Invalid("result_or_provenance_drift");
        }

        string expectedOperation = "resolution-" + Hash(new
        {
            OriginalPlan = current.Metadata.Plan.ContentSha256,
            Evidence = current.Evidence.ContentSha256,
            Git = current.Git.ContentSha256,
            current.Decisions,
            current.Confirmation,
            current.ExpiresAtUnixMs
        });
        return plan.ResolutionOperationIdentity == expectedOperation
            ? ArticleVaultValidationResult.Valid() : Invalid("operation_identity_drift");
    }

    /// <summary>Always refuses execution until the canonical owner supplies resolution admission.</summary>
    public static ArticleVaultValidationResult RequireExecutionAdmission(ArticleVaultResolutionPlan plan, ArticleVaultResolutionPlanInput current)
    {
        ArticleVaultValidationResult valid = VerifyCurrent(plan, current);
        return !valid.IsValid ? valid : Invalid(plan.State == VaultResolutionPlanState.Cancelled
            ? "cancelled" : "canonical_execution_admission_missing");
    }

    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultResolutionPlan? plan)
    {
        if (plan is null || plan.Schema != Schema || plan.SchemaVersion != 1 || !Enum.IsDefined(plan.State)
            || plan.Binding is null || plan.Confirmation is null || plan.Groups.IsDefaultOrEmpty
            || plan.Decisions.IsDefaultOrEmpty || plan.Decisions.Length > 12 || plan.ActionOrder.IsDefault
            || plan.Decisions.Any(static decision => decision is null || !Enum.IsDefined(decision.Type)
                || !Enum.IsDefined(decision.Action) || !Enum.IsDefined(decision.Provenance)
                || decision.ResultCandidateSha256 is not null && !ArticleVaultManifestValidator.IsSha256(decision.ResultCandidateSha256))
            || !plan.ActionOrder.SequenceEqual(plan.Decisions.Select(static decision => decision.Type))
            || !plan.Decisions.Select(static decision => decision.Type).SequenceEqual(
                plan.Decisions.Select(static decision => decision.Type).Distinct().Order())
            || !ArticleVaultManifestValidator.IsIdentity(plan.ResolutionOperationIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(plan.Confirmation.ConfirmationIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(plan.Confirmation.ActorIdentity)
            || plan.Confirmation.ConfirmedAtUnixMs <= 0 || plan.ExpiresAtUnixMs <= plan.Confirmation.ConfirmedAtUnixMs
            || !new[] { plan.EvidenceSha256, plan.GitFactsSha256, plan.RootManifestSha256, plan.FieldRegistrySha256, plan.ContentSha256 }
                .All(ArticleVaultManifestValidator.IsSha256))
        {
            return Invalid("structure_invalid");
        }

        bool cancelled = plan.Decisions.Any(static decision => decision.Action == VaultConflictAction.CancelOperation);
        if (plan.State != (cancelled ? VaultResolutionPlanState.Cancelled : VaultResolutionPlanState.Prepared)
            || cancelled && plan.ExpectedOutput is not null || !cancelled && plan.ExpectedOutput is null
            || plan.Groups.Any(static group => group is null || !ArticleVaultManifestValidator.IsIdentity(group.GroupIdentity)
                || !group.AllOrNothing || group.PortableArticleIdentities.IsDefaultOrEmpty || group.Dependencies.IsDefault)
            || plan.ContentSha256 != ComputeContentSha256(plan))
        {
            return Invalid("content_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static byte[] Serialize(ArticleVaultResolutionPlan plan)
    {
        ArticleVaultValidationResult result = ValidateStructure(plan);
        return result.IsValid ? ArticleVaultManifestCodec.SerializeCanonical(plan) : throw new InvalidDataException(result.ReasonCode);
    }

    public static ArticleVaultResolutionPlan Deserialize(ReadOnlySpan<byte> bytes)
    {
        ArticleVaultResolutionPlanResult result = TryDeserialize(bytes);
        return result.Plan ?? throw new InvalidDataException(result.ReasonCode);
    }

    /// <summary>Uses the sole closed codec and returns an explicit refusal without granting admission.</summary>
    public static ArticleVaultResolutionPlanResult TryDeserialize(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > ArticleVaultGitFactDecoder.MaxOutputBytes)
        {
            return new(null, "article_vault_resolution_size_limit");
        }

        try
        {
            ArticleVaultResolutionPlan? plan = ArticleVaultManifestCodec.DeserializeCanonical<ArticleVaultResolutionPlan>(bytes);
            ArticleVaultValidationResult result = ValidateStructure(plan);
            return result.IsValid ? new(plan, null) : new(null, result.ReasonCode);
        }
        catch (JsonException)
        {
            return new(null, "article_vault_resolution_schema_invalid");
        }
    }

    public static string ComputeContentSha256(ArticleVaultResolutionPlan plan)
        => Hash(plan with
        {
            ContentSha256 = string.Empty
        });

    private static ArticleVaultValidationResult ValidateInput(ArticleVaultResolutionPlanInput input, out VaultResolutionExpectedOutput? output)
    {
        output = null;
        if (input is null || input.Metadata is null || input.Evidence is null || input.Git is null
            || input.Confirmation is null || input.Decisions.IsDefaultOrEmpty)
        {
            return Invalid("input_missing");
        }

        ArticleVaultValidationResult evidence = ArticleVaultConflictVerifier.ValidateStructure(input.Evidence);
        if (!evidence.IsValid)
        {
            return evidence;
        }

        if (input.Evidence.Items.Any(static item => item.Type is not (VaultConflictType.MetadataDisjoint or VaultConflictType.MetadataOverlap)))
        {
            return Invalid("source_or_authority_candidate_reader_missing");
        }

        ArticleVaultScalarMetadataResult read = ArticleVaultScalarMetadataMerge.Build(input.Metadata);
        if (read.ReasonCode is not null && read.Conflict is null)
        {
            return ArticleVaultValidationResult.Invalid(read.ReasonCode);
        }

        VaultConflictObservation observation = read.Conflict
            ?? new(VaultConflictType.MetadataDisjoint, null, read.Candidate!.Facts, null);
        ArticleVaultValidationResult current = ArticleVaultConflictVerifier.VerifyCurrentBinding(input.Evidence,
            input.Metadata.Plan, input.Metadata.Root, input.Metadata.Articles, input.Metadata.Observations, input.Metadata.Context, [observation]);
        if (!current.IsValid)
        {
            return current;
        }

        VaultConflictBinding binding = input.Evidence.Binding;
        if (!Equal(binding, input.Metadata.Binding) || input.Git.Scope.SiteIdentity != binding.SiteIdentity
            || input.Git.Scope.VaultIdentity != binding.VaultIdentity || input.Git.Scope.DeviceIdentity != binding.DeviceIdentity
            || input.Git.Scope.RootManifestSha256 != input.Metadata.Root.ContentSha256)
        {
            return Invalid("git_or_candidate_binding_drift");
        }

        ArticleVaultValidationResult git = ArticleVaultGitFactDecoder.AdmitSource(input.Git,
            binding.PortableArticleIdentity, binding.Coordinates.Local.Source!.Sha256);
        if (!git.IsValid)
        {
            return git;
        }

        if (input.Decisions.Length != input.Evidence.Items.Length
            || !ArticleVaultManifestValidator.IsIdentity(input.Confirmation.ConfirmationIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(input.Confirmation.ActorIdentity)
            || input.Confirmation.ConfirmedAtUnixMs < input.Metadata.Plan.CreatedAtUnixMs
            || input.Confirmation.ConfirmedAtUnixMs > input.Metadata.Context.NowUnixMs
            || input.ExpiresAtUnixMs <= input.Metadata.Context.NowUnixMs || input.ExpiresAtUnixMs > input.Metadata.Plan.ExpiresAtUnixMs)
        {
            return Invalid("decision_confirmation_or_expiry_invalid");
        }

        for (int index = 0; index < input.Decisions.Length; index++)
        {
            VaultResolutionDecision? decision = input.Decisions[index];
            VaultConflictItem item = input.Evidence.Items[index];
            if (decision is null || decision.Type != item.Type || decision.Provenance != item.Disposition
                || !item.AllowedActions.Contains(decision.Action))
            {
                return Invalid($"decision_invalid_item_{index}");
            }

            if (decision.Action == VaultConflictAction.CancelOperation)
            {
                if (decision.ResultCandidateSha256 is not null)
                {
                    return Invalid($"cancel_result_present_item_{index}");
                }

                continue;
            }

            if (decision.Action != VaultConflictAction.PrepareMetadataCandidate)
            {
                return Invalid($"manual_candidate_reader_missing_item_{index}");
            }

            ArticleVaultValidationResult candidate = ArticleVaultScalarMetadataMerge.VerifyCurrentCandidate(
                input.Metadata, input.MetadataCandidate);
            if (!candidate.IsValid)
            {
                return candidate;
            }

            if (decision.ResultCandidateSha256 != input.MetadataCandidate!.ContentSha256
                || !Equal(input.MetadataCandidate.Facts, item.Observation.Metadata))
            {
                return Invalid($"candidate_digest_or_effects_drift_item_{index}");
            }

            output = new(binding.Coordinates.Server.ServerRevision, binding.Coordinates.Local.Source.Sha256,
                input.MetadataCandidate.Metadata.ContentSha256, binding.Coordinates.Server.DependencySha256!);
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static string Hash<T>(T value) => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(value));

    private static bool Equal<T>(T left, T right) => Hash(left) == Hash(right);

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_resolution_{reason}");
}
