using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>
/// Projects the existing sealed Linux raw contract into observation-only normalization inputs.
/// This adapter allocates no watcher and cannot grant snapshot, rescan or synchronization admission.
/// </summary>
public static class LinuxVaultObservationAdapter
{
    /// <summary>
    /// Revalidates each original fact and exact independently supplied binding before translation.
    /// Invalid facts are refused; the caller retains the window and must rescan on lost delivery.
    /// </summary>
    public static IReadOnlyList<VaultRawObservation> Convert(
        VaultObservationBinding binding,
        IReadOnlyList<LinuxVaultRawFact> facts)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(facts);
        if (binding.Scope is null)
        {
            throw new InvalidDataException("vault_observation_binding_invalid");
        }
        if (facts.Count > ArticleVaultEventNormalizer.MaxRawFacts)
        {
            throw new InvalidDataException("vault_observation_split_required");
        }

        var observations = new List<VaultRawObservation>(facts.Count);
        foreach (LinuxVaultRawFact fact in facts)
        {
            if (fact is null || fact.RootManifestSha256 is not { Length: 64 }
                || fact.ContentSha256 is not { Length: 64 } || !LinuxVaultRawFactCodec.Validate(fact)
                || fact.SiteIdentity != binding.Scope.SiteIdentity
                || fact.VaultIdentity != binding.Scope.VaultIdentity
                || fact.DeviceIdentity != binding.Scope.DeviceIdentity
                || fact.AgentIdentity != binding.Scope.AgentIdentity
                || fact.RootIdentity != binding.Scope.RootIdentitySha256
                || fact.RootManifestSha256 != binding.Scope.RootManifestSha256
                || fact.WatchInstanceIdentity != binding.WatchInstanceIdentity)
            {
                throw new InvalidDataException("vault_observation_native_fact_invalid");
            }

            VaultRawObservationClass kind = fact.FactClass switch
            {
                LinuxVaultFactClass.Created => VaultRawObservationClass.Created,
                LinuxVaultFactClass.Modified => VaultRawObservationClass.Modified,
                LinuxVaultFactClass.AttributesChanged => VaultRawObservationClass.AttributesChanged,
                LinuxVaultFactClass.ClosedAfterWrite => VaultRawObservationClass.ClosedAfterWrite,
                LinuxVaultFactClass.MovedFrom => VaultRawObservationClass.MovedFrom,
                LinuxVaultFactClass.MovedTo => VaultRawObservationClass.MovedTo,
                LinuxVaultFactClass.Deleted => VaultRawObservationClass.Deleted,
                LinuxVaultFactClass.WatcherRestarted => VaultRawObservationClass.Restarted,
                LinuxVaultFactClass.QueueOverflow => VaultRawObservationClass.Overflow,
                LinuxVaultFactClass.PermissionBlocked => VaultRawObservationClass.PermissionBlocked,
                LinuxVaultFactClass.RootLost or LinuxVaultFactClass.DeleteSelf or LinuxVaultFactClass.MoveSelf
                    or LinuxVaultFactClass.Unmounted => VaultRawObservationClass.RootLost,
                LinuxVaultFactClass.WatchInvalidated or LinuxVaultFactClass.DynamicWatchFailed
                    => VaultRawObservationClass.WatchInvalidated,
                LinuxVaultFactClass.Unknown => VaultRawObservationClass.Unknown,
                _ => throw new InvalidDataException("vault_observation_native_class_unmapped")
            };
            string? path = fact.RawOldRelativePath ?? fact.RawNewRelativePath;
            bool rootEvent = path == string.Empty;
            if (rootEvent)
            {
                kind = VaultRawObservationClass.WatchInvalidated;
                path = null;
            }

            observations.Add(new(fact.Sequence, kind, path, fact.CookieDiagnostic,
                fact.RescanRequired || rootEvent, fact.WatermarkValid && !rootEvent,
                rootEvent ? "vault_observation_root_revalidation_required" : fact.ErrorCode,
                fact.ContentSha256));
        }

        return observations.ToArray();
    }
}
