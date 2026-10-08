using System.Collections.Immutable;

using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Services.ArticleVault.Assets;

/// <summary>
/// Freezes the original upload observation under an exact plan and item. This is staging
/// preparation, not a persisted stage, upload receipt, native instruction or authorization grant.
/// Whole-plan operation and per-article item identities deliberately remain distinct.
/// </summary>
public sealed record ArticleVaultAssetUploadHandoff(
    ArticleVaultOperationIdentity Operation,
    string DependencyPlanSha256,
    string GroupIdentity,
    string ItemOperationIdentity,
    string PortableArticleIdentity,
    string ArticleSourceSha256,
    VaultAssetDependency Asset,
    UploadAssetObservation Observation,
    string PreparationIdentity,
    string ContentSha256)
{
    /// <summary>Names the versioned observation handoff, distinct from an execution receipt.</summary>
    public string Schema => ArticleVaultAssetUploadHandoffCodec.Schema;

    /// <summary>Versions this preparation contract without changing the canonical operation schema.</summary>
    public int SchemaVersion => ArticleVaultAssetUploadHandoffCodec.Version;

    /// <summary>The native owner has no asset path/conditional replacement admission yet.</summary>
    public bool CanMaterialize => false;

    /// <summary>Observation alone cannot update an article manifest or synchronized base.</summary>
    public bool CanCommitBase => false;

    /// <summary>Retrying preparation rereads the same original session; it never creates an upload.</summary>
    public bool CanStartUpload => false;

    /// <summary>These missing owner capabilities cannot be inferred from a valid handoff seal.</summary>
    public ImmutableArray<string> MissingCapabilities =>
    [
        "canonical_asset_stage_persistence_and_plan_bound_upload",
        "canonical_vault_asset_rights_and_revision_receipt",
        "canonical_portable_asset_path_projection",
        "native_asset_conditional_materialization_and_recovery",
        "atomic_verified_manifest_base_receipt_commit"
    ];
}

/// <summary>Uses the original Vault codec; no operation, upload or ledger identity is allocated.</summary>
public static class ArticleVaultAssetUploadHandoffCodec
{
    public const string Schema = "fsusblog.article-vault.asset-upload-handoff.v1";
    public const int Version = 1;

    /// <summary>Content-addresses the exact preparation scope; observation drift changes its seal.</summary>
    public static string ComputePreparationIdentity(ArticleVaultAssetUploadHandoff handoff)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultOperationCodec.Serialize(new
        {
            handoff.Schema,
            handoff.SchemaVersion,
            handoff.Operation.SiteIdentity,
            handoff.Operation.VaultIdentity,
            handoff.Operation.DeviceIdentity,
            handoff.Operation.AgentIdentity,
            handoff.Operation.PlanReference,
            handoff.Operation.PlanSha256,
            OperationSha256 = handoff.Operation.ContentSha256,
            handoff.DependencyPlanSha256,
            handoff.GroupIdentity,
            handoff.ItemOperationIdentity,
            handoff.PortableArticleIdentity,
            handoff.ArticleSourceSha256,
            handoff.Asset.AssetIdentity,
            AssetSha256 = handoff.Asset.ContentSha256
        }));

    /// <summary>A matching seal is integrity evidence only; current authority is rechecked by the adapter.</summary>
    public static string ComputeContentSha256(ArticleVaultAssetUploadHandoff handoff)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultOperationCodec.Serialize(handoff with
        {
            ContentSha256 = string.Empty
        }));
}
