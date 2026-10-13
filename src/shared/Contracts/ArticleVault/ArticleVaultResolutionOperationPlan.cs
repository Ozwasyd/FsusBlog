using System.Collections.Immutable;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Associates a frozen original atomic group with its new resolution operation group.</summary>
public sealed record VaultResolutionOperationGroup(string OriginalGroupIdentity, string ResolutionGroupIdentity);

/// <summary>
/// Binds a new canonical operation/plan to the original proposal and expected outputs. Coordinates
/// remain actual observations, not asserted materialized candidate facts. The canonical planner's
/// blockers are preserved; this contract does not grant executable resolution or backup authority.
/// </summary>
public sealed record ArticleVaultResolutionOperationPlan(
    string Schema,
    int SchemaVersion,
    VaultRecoveryReference Proposal,
    VaultRecoveryReference OriginalSyncPlan,
    ImmutableArray<VaultResolutionOperationGroup> Groups,
    ArticleVaultSyncPlan SyncPlan,
    ArticleVaultOperationIdentity Operation,
    VaultResolutionExpectedOutput? ExpectedOutput,
    string ContentSha256);

/// <summary>Returns the verified new operation plan or the exact current/planner refusal.</summary>
public sealed record ArticleVaultResolutionOperationPlanResult(
    ArticleVaultResolutionOperationPlan? Plan,
    string? ReasonCode);

/// <summary>
/// Calls the existing sole sync planner and operation binder after current proposal verification.
/// It never changes base/local/server observations or the original plan's decisions. Canonical
/// resolution decision admission is a missing planner capability, not a reason to forge Ready.
/// </summary>
public static class ArticleVaultResolutionOperationPlanner
{
    public const string Schema = "fsusblog.article-vault.resolution-operation-plan.v1";

    public static ArticleVaultResolutionOperationPlanResult Build(
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current)
    {
        ArticleVaultValidationResult verified = ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current);
        if (!verified.IsValid)
        {
            return new(null, verified.ReasonCode);
        }

        ImmutableArray<VaultResolutionOperationGroup> groups = proposal.Groups.Select(group =>
            new VaultResolutionOperationGroup(group.GroupIdentity, "resolution-group-" + Digest(new
            {
                Proposal = proposal.ContentSha256,
                group.GroupIdentity
            })[..32])).ToImmutableArray();
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new(
            current.Metadata.Root, current.Metadata.Articles, current.Metadata.Observations,
            proposal.Groups.Select((group, index) => new VaultPlanGroupRequest(groups[index].ResolutionGroupIdentity,
                group.PortableArticleIdentities, group.Dependencies)).ToArray(), current.Metadata.Context.Direction,
            proposal.Confirmation.ConfirmedAtUnixMs, proposal.ExpiresAtUnixMs,
            proposal.State == VaultResolutionPlanState.Cancelled));
        if (!built.IsSuccess)
        {
            return new(null, built.Errors.FirstOrDefault() ?? "article_vault_resolution_operation_planner_rejected");
        }

        ArticleVaultSyncPlan syncPlan = built.Plan!;
        ArticleVaultOperationIdentity operation = ArticleVaultOperationVerifier.Bind(syncPlan,
            current.Git.Scope.AgentIdentity, proposal.ContentSha256, Digest(new
            {
                Proposal = proposal.ContentSha256,
                Plan = syncPlan.ContentSha256
            }), proposal.ExpiresAtUnixMs);
        ArticleVaultResolutionOperationPlan result = new(Schema, 1,
            new(proposal.ResolutionOperationIdentity, proposal.ContentSha256),
            new(current.Metadata.Plan.PlanCandidateIdentity, current.Metadata.Plan.ContentSha256),
            groups, syncPlan, operation, proposal.ExpectedOutput, string.Empty);
        result = result with
        {
            ContentSha256 = ComputeContentSha256(result)
        };
        ArticleVaultValidationResult structure = ValidateStructure(result);
        return structure.IsValid ? new(result, null) : new(null, structure.ReasonCode);
    }

    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultResolutionOperationPlan? plan)
    {
        if (plan is null || plan.Schema != Schema || plan.SchemaVersion != 1
            || !ReferenceValid(plan.Proposal) || !ReferenceValid(plan.OriginalSyncPlan)
            || plan.Groups.IsDefaultOrEmpty || plan.SyncPlan is null || plan.Operation is null
            || plan.Groups.Length != plan.SyncPlan.Groups.Count
            || plan.Groups.Any(static group => group is null
                || !ArticleVaultManifestValidator.IsIdentity(group.OriginalGroupIdentity)
                || !ArticleVaultManifestValidator.IsIdentity(group.ResolutionGroupIdentity))
            || plan.Groups.Select(static group => group.OriginalGroupIdentity).Distinct().Count() != plan.Groups.Length
            || plan.Groups.Select(static group => group.ResolutionGroupIdentity).Distinct().Count() != plan.Groups.Length
            || !plan.Groups.Select(static group => group.ResolutionGroupIdentity).Order(StringComparer.Ordinal)
                .SequenceEqual(plan.SyncPlan.Groups.Select(static group => group.GroupIdentity).Order(StringComparer.Ordinal))
            || plan.SyncPlan.PlanCandidateIdentity == plan.OriginalSyncPlan.Identity
            || plan.Operation.RequestSha256 != plan.Proposal.ContentSha256
            || plan.ContentSha256 != ComputeContentSha256(plan))
        {
            return Invalid("structure_or_binding_invalid");
        }

        ArticleVaultValidationResult sync = ArticleVaultSyncPlanVerifier.ValidateStructure(plan.SyncPlan);
        return !sync.IsValid ? sync : ArticleVaultOperationVerifier.ValidateIdentity(plan.Operation, plan.SyncPlan);
    }

    public static ArticleVaultValidationResult VerifyCurrent(
        ArticleVaultResolutionOperationPlan plan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current)
    {
        ArticleVaultValidationResult structure = ValidateStructure(plan);
        if (!structure.IsValid)
        {
            return structure;
        }

        ArticleVaultResolutionOperationPlanResult rebuilt = Build(proposal, current);
        return rebuilt.Plan is null ? ArticleVaultValidationResult.Invalid(rebuilt.ReasonCode!)
            : rebuilt.Plan.ContentSha256 == plan.ContentSha256
                ? ArticleVaultValidationResult.Valid() : Invalid("current_plan_drift");
    }

    public static ArticleVaultValidationResult RequireExecutionAdmission(
        ArticleVaultResolutionOperationPlan plan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current)
    {
        ArticleVaultValidationResult valid = VerifyCurrent(plan, proposal, current);
        return !valid.IsValid ? valid : Invalid(plan.SyncPlan.CancellationRequested ? "cancelled"
            : plan.SyncPlan.Status == VaultSyncPlanStatus.Blocked ? "canonical_planner_decision_admission_missing"
            : "canonical_candidate_payload_admission_missing");
    }

    public static string ComputeContentSha256(ArticleVaultResolutionOperationPlan plan)
        => Digest(plan with
        {
            ContentSha256 = string.Empty
        });

    private static bool ReferenceValid(VaultRecoveryReference? reference)
        => reference is not null && ArticleVaultManifestValidator.IsIdentity(reference.Identity)
            && ArticleVaultManifestValidator.IsSha256(reference.ContentSha256);

    private static string Digest<T>(T value)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(value));

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid("article_vault_resolution_operation_" + reason);
}
