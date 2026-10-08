using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>
/// Projects validated Windows raw facts into the canonical #2112 input vocabulary without
/// normalizing event order, pairing renames, reading content or granting native/sync admission.
/// </summary>
public static class WindowsVaultObservationAdapter
{
    /// <summary>
    /// Checks independently supplied manifest/root/watch coordinates and each original digest.
    /// Native separators become portable separators only in the derived projection; raw facts stay
    /// intact. Invalid projections retain their native digest and become mandatory rescan facts.
    /// </summary>
    public static IReadOnlyList<VaultRawObservation> Convert(
        ArticleVaultRootManifest root,
        VaultObservationBinding binding,
        WindowsVaultWatchIdentity expectedIdentity,
        IReadOnlyList<WindowsVaultRawFact> facts)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(expectedIdentity);
        ArgumentNullException.ThrowIfNull(facts);
        VaultPathStructuralScope? scope = binding.Scope;
        if (scope is null || !ArticleVaultPathStructureValidator.ValidateScope(root, scope).IsValid)
        {
            throw new InvalidDataException("vault_observation_binding_invalid");
        }

        if (string.IsNullOrEmpty(binding.WatchInstanceIdentity)
            || binding.WatchInstanceIdentity.Length > 128
            || expectedIdentity.FileSystem != "NTFS"
            || expectedIdentity.SiteIdentity != scope.SiteIdentity
            || expectedIdentity.VaultIdentity != scope.VaultIdentity
            || expectedIdentity.DeviceIdentity != scope.DeviceIdentity
            || expectedIdentity.AgentIdentity != scope.AgentIdentity
            || expectedIdentity.RootIdentity != scope.RootIdentitySha256
            || expectedIdentity.RootManifestSha256 != scope.RootManifestSha256
            || expectedIdentity.WatchInstanceIdentity != binding.WatchInstanceIdentity
            || scope.ComparisonPolicy != (expectedIdentity.CaseSensitive
                ? VaultPathComparisonPolicy.Ordinal : VaultPathComparisonPolicy.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("vault_observation_binding_invalid");
        }

        if (facts.Count > ArticleVaultEventNormalizer.MaxRawFacts)
        {
            throw new InvalidDataException("vault_observation_split_required");
        }

        var observations = new List<VaultRawObservation>(facts.Count);
        foreach (WindowsVaultRawFact fact in facts)
        {
            if (fact is null || fact.Identity is null
                || !WindowsVaultRawFactCodec.Verify(fact, expectedIdentity))
            {
                throw new InvalidDataException("vault_observation_native_fact_invalid");
            }

            VaultRawObservationClass kind = fact.FactClass switch
            {
                WindowsVaultFactClass.Added => VaultRawObservationClass.Created,
                WindowsVaultFactClass.Removed => VaultRawObservationClass.Deleted,
                WindowsVaultFactClass.Modified => VaultRawObservationClass.Modified,
                WindowsVaultFactClass.RenameOldName => VaultRawObservationClass.MovedFrom,
                WindowsVaultFactClass.RenameNewName => VaultRawObservationClass.MovedTo,
                WindowsVaultFactClass.WatcherRestarted => VaultRawObservationClass.Restarted,
                WindowsVaultFactClass.BufferOverflow => VaultRawObservationClass.Overflow,
                WindowsVaultFactClass.PermissionBlocked or WindowsVaultFactClass.SharingBlocked
                    => VaultRawObservationClass.PermissionBlocked,
                WindowsVaultFactClass.RootLost => VaultRawObservationClass.RootLost,
                WindowsVaultFactClass.SecurityBlocked or WindowsVaultFactClass.WatchInvalidated
                    => VaultRawObservationClass.WatchInvalidated,
                WindowsVaultFactClass.Unknown => VaultRawObservationClass.Unknown,
                _ => throw new InvalidDataException("vault_observation_native_class_unmapped")
            };
            string? rawPath = fact.RawOldRelativePath ?? fact.RawNewRelativePath;
            string? projection = rawPath?.Replace('\\', '/');
            bool projectionInvalid = projection is not null
                && !ArticleVaultPathStructureValidator.ValidateRelativePath(projection).IsValid;
            if (projectionInvalid)
            {
                kind = VaultRawObservationClass.WatchInvalidated;
                projection = null;
            }

            observations.Add(new(fact.Sequence, kind, projection, null,
                fact.RescanRequired || projectionInvalid, false,
                projectionInvalid ? fact.ReasonCode ?? "windows_vault_observation_projection_invalid" : fact.ReasonCode,
                fact.ContentDigest));
        }

        return observations.ToArray();
    }
}
