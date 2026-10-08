namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Content-addresses bounded local diagnostics with the existing canonical Vault serializer.
/// Digests never establish native completion, accepted-result authority or permission to commit.
/// </summary>
public static class ArticleVaultLocalPreparationDigestCodec
{
    /// <summary>Seals the scanner's ordinal inventory, exact obligation and provisional observations.</summary>
    public static string ComputeRescanSha256(VaultRescanObligation obligation,
        IReadOnlyList<string> directoryPaths, IReadOnlyList<string> leafPaths,
        IReadOnlyList<VaultFilesystemObservation> observations, bool treeEnumerationCompleted, string reasonCode)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            Schema = "fsusblog.article-vault.native-rescan-diagnostic.v1",
            Obligation = obligation,
            DirectoryPaths = directoryPaths,
            LeafPaths = leafPaths,
            Observations = observations,
            TreeEnumerationCompleted = treeEnumerationCompleted,
            ReasonCode = reasonCode
        }));

    /// <summary>Seals completed preparation stages and retained-artifact diagnostics without any source body.</summary>
    public static string ComputeTemporarySha256(VaultPathStructuralScope scope,
        ArticleVaultMaterializationInstruction instruction, string? temporaryRelativePath, string stage,
        VaultFileMetadataObservation? temporaryMetadata, string reasonCode, IReadOnlyList<string> requiredCapabilities)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            Schema = "fsusblog.article-vault.temporary-source-diagnostic.v1",
            Scope = scope,
            InstructionSha256 = instruction.ContentSha256,
            OperationIdentity = instruction.OperationIdentity,
            JournalIdentity = instruction.JournalIdentity,
            TemporaryRelativePath = temporaryRelativePath,
            Stage = stage,
            TemporaryMetadata = temporaryMetadata,
            DesiredSource = instruction.NewSource,
            ReasonCode = reasonCode,
            RequiredCapabilities = requiredCapabilities
        }));
}
