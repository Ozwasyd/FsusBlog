using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Consumes the canonical sealed plan and exact verified server result without executing either
/// authority. Emits conditional source instructions only; unavailable accepted-coordinate, manifest
/// and native commit capabilities remain explicit blockers. No preflight result grants file access.
/// </summary>
public static class ArticleVaultMaterializationPreflightVerifier
{
    public static ArticleVaultMaterializationPreflight Prepare(
        ArticleVaultSealedExecutionBundle bundle,
        ArticleVaultExecutionResult result,
        ArticleVaultOperationIdentity operation)
    {
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan));
        if (result.Outcome is not (ArticleVaultExecutionOutcome.Completed or ArticleVaultExecutionOutcome.NoOp))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_materialization_server_not_accepted");
        }

        var instructions = new List<ArticleVaultMaterializationInstruction>();
        Dictionary<string, ArticleVaultArticleManifest> articles = bundle.ArticleManifests
            .ToDictionary(static article => article.PortableArticleIdentity, StringComparer.Ordinal);
        for (int groupIndex = 0; groupIndex < bundle.Plan.Groups.Count; groupIndex++)
        {
            VaultSyncPlanGroup group = bundle.Plan.Groups[groupIndex];
            ArticleVaultGroupResultReceipt receipt = result.Groups[groupIndex];
            for (int itemIndex = 0; itemIndex < group.Items.Count; itemIndex++)
            {
                VaultSyncPlanItem item = group.Items[itemIndex];
                ArticleVaultOperationResultReceipt server = receipt.Operations[itemIndex];
                VaultSourceByteIdentity? oldSource = item.Local.Present ? item.Local.Source : null;
                VaultSourceByteIdentity? newSource = item.Decision switch
                {
                    VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate => item.Server.Source,
                    VaultSyncDecision.PullDelete or VaultSyncDecision.PushDelete => null,
                    VaultSyncDecision.NoOp or VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate => item.Local.Source,
                    _ => throw new ArticleVaultExecutionRejectedException("article_vault_materialization_decision_blocked")
                };
                if (newSource is not null && server.ArticleContentSha256 != newSource.Sha256)
                {
                    throw new ArticleVaultExecutionRejectedException("article_vault_materialization_server_source_mismatch");
                }

                ArticleVaultArticleManifest article = articles[item.PortableArticleIdentity];
                VaultMaterializationSourceAction action = (oldSource, newSource) switch
                {
                    (null, not null) => VaultMaterializationSourceAction.Create,
                    (not null, null) => VaultMaterializationSourceAction.Remove,
                    _ when oldSource == newSource => VaultMaterializationSourceAction.VerifyUnchanged,
                    _ => VaultMaterializationSourceAction.Update
                };
                ArticleVaultMaterializationInstruction instruction = new(
                    ArticleVaultMaterializationInstructionCodec.Schema,
                    ArticleVaultMaterializationInstructionCodec.Version,
                    bundle.Plan.SiteIdentity, bundle.Plan.VaultIdentity, bundle.Plan.DeviceIdentity, operation.AgentIdentity,
                    bundle.PlanReference, bundle.PlanSha256, bundle.Plan.RootManifestSha256,
                    result.ResultReference, result.ContentSha256,
                    group.GroupIdentity, item.OperationIdentity, item.PortableArticleIdentity,
                    article.PathProjection, action, oldSource, newSource, item.Local.MetadataManifestSha256, item.Base.ContentSha256,
                    operation.OperationIdentity, string.Empty);
                instructions.Add(instruction with
                {
                    ContentSha256 = ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
                });
            }
        }

        return new ArticleVaultMaterializationPreflight(instructions,
        [
            "accepted_server_coordinate_and_metadata_bytes",
            "canonical_portable_path_projection_codec",
            "native_conditional_write_and_readback",
            "atomic_verified_manifest_base_receipt_commit"
        ]);
    }
}
