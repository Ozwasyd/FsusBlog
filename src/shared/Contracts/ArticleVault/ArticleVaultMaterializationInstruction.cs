namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Identifies a conditional source action; it is not a native write capability.</summary>
public enum VaultMaterializationSourceAction
{
    Create,
    Update,
    Remove,
    VerifyUnchanged
}

/// <summary>
/// Freezes one source instruction for the sole native adapter. ExpectedOldSource null means the path
/// must be absent. NewSource null permits removal only with an exact expected old byte identity.
/// Source bytes travel separately under this digest and must never be decoded/re-encoded for writing.
/// This instruction cannot update a base, article manifest or synced marker.
/// </summary>
public sealed record ArticleVaultMaterializationInstruction(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string PlanReference,
    string PlanSha256,
    string RootManifestSha256,
    string ServerResultReference,
    string ServerResultSha256,
    string GroupIdentity,
    string OperationIdentity,
    string PortableArticleIdentity,
    VaultPathProjection PathProjection,
    VaultMaterializationSourceAction Action,
    VaultSourceByteIdentity? ExpectedOldSource,
    VaultSourceByteIdentity? NewSource,
    string? ExpectedOldMetadataManifestSha256,
    string BaseBeforeSha256,
    string JournalIdentity,
    string ContentSha256);

/// <summary>
/// Describes source preflight only. Complete materialization additionally needs accepted server
/// coordinates/metadata bytes, native conditional-write receipts and an atomic base/receipt commit.
/// </summary>
public sealed record ArticleVaultMaterializationPreflight(
    IReadOnlyList<ArticleVaultMaterializationInstruction> SourceInstructions,
    IReadOnlyList<string> MissingCapabilities)
{
    public bool CanCommitBase => false;
}

/// <summary>Seals semantic instructions with the existing closed Vault canonical codec.</summary>
public static class ArticleVaultMaterializationInstructionCodec
{
    public const string Schema = "fsusblog.article-vault.materialization-source-instruction.v1";
    public const int Version = 1;

    public static string ComputeContentSha256(ArticleVaultMaterializationInstruction instruction)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(
            instruction with
            {
                ContentSha256 = string.Empty
            }));

    /// <summary>Validates supplied source bytes without formatting or normalization.</summary>
    public static ArticleVaultValidationResult VerifyBytes(
        ArticleVaultMaterializationInstruction instruction,
        ReadOnlySpan<byte> bytes)
        => instruction.ContentSha256 != ComputeContentSha256(instruction)
            ? ArticleVaultValidationResult.Invalid("article_vault_materialization_instruction_tampered")
            : instruction.NewSource is null
                ? ArticleVaultValidationResult.Invalid("article_vault_materialization_source_not_expected")
                : ArticleVaultManifestValidator.ValidateSourceBytes(instruction.NewSource, bytes);
}
