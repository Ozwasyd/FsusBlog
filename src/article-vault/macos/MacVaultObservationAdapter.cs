using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.MacOS;

/// <summary>
/// Projects validated macOS facts into the sole canonical observation vocabulary. It performs no
/// normalization, snapshot read, rescan completion or synchronization admission.
/// </summary>
public static class MacVaultObservationAdapter
{
    /// <summary>Copies the watch binding into structural inputs without granting native authority.</summary>
    public static VaultObservationBinding Binding(MacVaultWatchIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        if (identity.Filesystem is null || identity.Filesystem.FileSystem != "apfs")
        {
            throw new InvalidDataException("mac_vault_observation_binding_invalid");
        }

        return new(new(identity.SiteIdentity, identity.VaultIdentity, identity.DeviceIdentity,
            identity.AgentIdentity, identity.RootIdentitySha256, identity.RootManifestSha256,
            identity.Filesystem.CaseSensitive ? VaultPathComparisonPolicy.CanonicalUnicode
                : VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase), identity.WatchInstanceIdentity);
    }

    /// <summary>
    /// Verifies the independently held native identity and canonical binding before projection.
    /// Coalesced operations and unpaired rename flags become unknown/rescan, never invented moves.
    /// </summary>
    public static IReadOnlyList<VaultRawObservation> Convert(
        VaultObservationBinding binding,
        MacVaultWatchIdentity expectedIdentity,
        IReadOnlyList<MacVaultRawFact> facts)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(facts);
        if (binding != Binding(expectedIdentity))
        {
            throw new InvalidDataException("mac_vault_observation_binding_invalid");
        }

        if (facts.Count > ArticleVaultEventNormalizer.MaxRawFacts)
        {
            throw new InvalidDataException("vault_observation_split_required");
        }

        var observations = new List<VaultRawObservation>(facts.Count);
        foreach (MacVaultRawFact fact in facts)
        {
            if (!MacVaultRawFactCodec.Validate(fact, expectedIdentity))
            {
                throw new InvalidDataException("mac_vault_observation_native_fact_invalid");
            }

            VaultRawObservationClass kind = Classify(fact);
            string? relative = fact.RawObservedRelativePath;
            if (relative == string.Empty)
            {
                relative = null;
                kind = VaultRawObservationClass.WatchInvalidated;
            }

            observations.Add(new(fact.Sequence, kind, relative, null, true, false,
                fact.ErrorCode, fact.ContentSha256));
        }

        return observations.ToArray();
    }

    private static VaultRawObservationClass Classify(MacVaultRawFact fact)
    {
        if (fact.FactClass == MacVaultFactClass.WatcherRestarted)
        {
            return VaultRawObservationClass.Restarted;
        }

        if (fact.FactClass == MacVaultFactClass.DeliveryOverflow)
        {
            return VaultRawObservationClass.Overflow;
        }

        if (fact.ErrorCode == "mac_vault_permission_blocked")
        {
            return VaultRawObservationClass.PermissionBlocked;
        }

        if (fact.ErrorCode == "mac_vault_root_lost" || (fact.NativeFlags & 0xa0u) != 0)
        {
            return VaultRawObservationClass.RootLost;
        }

        if ((fact.NativeFlags & 0x4fu) != 0 || (fact.NativeFlags & ~0x7fffffu) != 0)
        {
            return VaultRawObservationClass.WatchInvalidated;
        }

        if (fact.FactClass != MacVaultFactClass.NativeEvent || (fact.NativeFlags & 0x800u) != 0)
        {
            return VaultRawObservationClass.Unknown;
        }

        uint operations = fact.NativeFlags & 0xff00u;
        return operations switch
        {
            0x100u => VaultRawObservationClass.Created,
            0x200u => VaultRawObservationClass.Deleted,
            0x1000u => VaultRawObservationClass.Modified,
            _ when operations != 0 && (operations & ~0xe400u) == 0 => VaultRawObservationClass.AttributesChanged,
            _ => VaultRawObservationClass.Unknown
        };
    }
}
