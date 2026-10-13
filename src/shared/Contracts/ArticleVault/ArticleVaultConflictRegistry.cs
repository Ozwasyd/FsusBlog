using System.Collections.Immutable;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Owns the immutable exact-one registry for all twelve conflict classifications.</summary>
public static class ArticleVaultConflictRegistry
{
    public static ImmutableArray<VaultConflictRegistryEntry> Entries
    {
        get;
    } =
    [
        Entry(VaultConflictType.SourceDisjoint, VaultConflictDisposition.Automatic, "issue-2117", VaultConflictFactKind.SourceChanges, VaultConflictAuthorityBoundary.VerifiedSourceCandidate, VaultConflictAction.PrepareSourceCandidate),
        Entry(VaultConflictType.SourceOverlap, VaultConflictDisposition.Manual, "issue-2117", VaultConflictFactKind.SourceChanges, VaultConflictAuthorityBoundary.VerifiedSourceCandidate, VaultConflictAction.ProposeSourceReplacement),
        Entry(VaultConflictType.MetadataDisjoint, VaultConflictDisposition.Automatic, "issue-2118", VaultConflictFactKind.MetadataChanges, VaultConflictAuthorityBoundary.VerifiedMetadataCandidate, VaultConflictAction.PrepareMetadataCandidate),
        Entry(VaultConflictType.MetadataOverlap, VaultConflictDisposition.Manual, "issue-2118", VaultConflictFactKind.MetadataChanges, VaultConflictAuthorityBoundary.VerifiedMetadataCandidate, VaultConflictAction.ProposeMetadataReplacement),
        Entry(VaultConflictType.RenameVsEdit, VaultConflictDisposition.Manual, "issue-2120", VaultConflictFactKind.IdentityProjection, VaultConflictAuthorityBoundary.PortableIdentity, VaultConflictAction.RequestRefactorPlan),
        Entry(VaultConflictType.DeleteVsEdit, VaultConflictDisposition.Manual, "issue-2120", VaultConflictFactKind.Deletion, VaultConflictAuthorityBoundary.CanonicalDeletion, VaultConflictAction.RequestDeletionPlan),
        Entry(VaultConflictType.CreateCreate, VaultConflictDisposition.Rejected, "issue-2120", VaultConflictFactKind.Creation, VaultConflictAuthorityBoundary.PortableIdentity, VaultConflictAction.RefreshEvidence),
        Entry(VaultConflictType.LifecycleConflict, VaultConflictDisposition.Rejected, "server-lifecycle", VaultConflictFactKind.Lifecycle, VaultConflictAuthorityBoundary.ServerLifecycle, VaultConflictAction.RefreshEvidence),
        Entry(VaultConflictType.PermissionConflict, VaultConflictDisposition.Rejected, "server-permission", VaultConflictFactKind.Permission, VaultConflictAuthorityBoundary.ServerPermission, VaultConflictAction.RefreshEvidence),
        Entry(VaultConflictType.SchemaConflict, VaultConflictDisposition.Rejected, "issue-2103", VaultConflictFactKind.Schema, VaultConflictAuthorityBoundary.Schema, VaultConflictAction.RefreshEvidence),
        Entry(VaultConflictType.DependencyConflict, VaultConflictDisposition.Rejected, "issue-2124", VaultConflictFactKind.Dependency, VaultConflictAuthorityBoundary.Dependency, VaultConflictAction.RefreshEvidence),
        Entry(VaultConflictType.GitMarkerPresent, VaultConflictDisposition.Rejected, "issue-2119", VaultConflictFactKind.GitMarkers, VaultConflictAuthorityBoundary.GitFactsOnly, VaultConflictAction.RefreshEvidence)
    ];

    public static string ContentSha256
    {
        get;
    } = ArticleVaultManifestCodec.ComputeSha256(
        ArticleVaultManifestCodec.SerializeCanonical(new
        {
            Schema = ArticleVaultConflictSchemas.Registry,
            SchemaVersion = ArticleVaultConflictSchemas.Version,
            Entries
        }));

    /// <summary>Rejects an unknown type instead of supplying a generic disposition.</summary>
    public static VaultConflictRegistryEntry? Find(VaultConflictType type)
        => Enum.IsDefined(type) ? Entries[(int)type - 1] : null;

    /// <summary>Requires an exact immutable registry, including owner, action and proof-test bindings.</summary>
    public static ArticleVaultValidationResult Validate(ImmutableArray<VaultConflictRegistryEntry> entries)
    {
        if (entries.IsDefault || entries.Length != Entries.Length)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_conflict_registry_incomplete");
        }

        for (int index = 0; index < entries.Length; index++)
        {
            VaultConflictRegistryEntry expected = Entries[index];
            VaultConflictRegistryEntry? actual = entries[index];
            if (actual is null
                || actual.Type != expected.Type
                || actual.Disposition != expected.Disposition
                || actual.Owner != expected.Owner
                || actual.RequiredFact != expected.RequiredFact
                || actual.AuthorityBoundary != expected.AuthorityBoundary
                || actual.ProofTestIdentity != expected.ProofTestIdentity
                || actual.AllowedActions.IsDefault
                || !actual.AllowedActions.SequenceEqual(expected.AllowedActions))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_conflict_registry_drift");
            }
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static VaultConflictRegistryEntry Entry(
        VaultConflictType type,
        VaultConflictDisposition disposition,
        string owner,
        VaultConflictFactKind fact,
        VaultConflictAuthorityBoundary authority,
        VaultConflictAction action)
        => new(type, disposition, owner, fact, [action, VaultConflictAction.CancelOperation], authority,
            $"ArticleVaultConflictTests.Registry_PreservesAuthority({type})");
}
