using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Tracks immutable, owner-bound rescan attempts and verifies full supplied manifest/tree inventory.
/// It performs no disk enumeration; structural completion awaits original native verification.
/// </summary>
public static class ArticleVaultRescanTracker
{
    public const string Schema = "fsusblog.article-vault.rescan-obligation.v1";
    public const int MaxAttempts = 16;

    /// <summary>Creates a mandatory root-wide rescan without releasing any synchronization admission.</summary>
    public static VaultRescanObligation Require(
        VaultObservationBinding binding,
        string ownerIdentity,
        VaultObservationWatermark before,
        IReadOnlyList<string> reasons)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(reasons);
        if (!ArticleVaultManifestValidator.IsIdentity(ownerIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.WatchInstanceIdentity)
            || before.LastSequence < 0
            || !ArticleVaultManifestValidator.IsSha256(before.FilesystemSnapshotSha256)
            || reasons.Count is 0 or > ArticleVaultEventNormalizer.MaxRawFacts
            || reasons.Any(static reason => !IsReason(reason)))
        {
            throw new InvalidDataException("vault_rescan_request_invalid");
        }

        var obligation = new VaultRescanObligation(Schema, 1, binding, ownerIdentity,
            string.Empty, reasons.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            before, VaultRescanState.Required, 0, null, null, string.Empty);
        VaultRescanObligation result = Seal(obligation);
        if (!Validate(result))
        {
            throw new InvalidDataException("vault_rescan_request_invalid");
        }

        return result;
    }

    /// <summary>Starts one bounded attempt for the same exact owner; failed attempts remain auditable.</summary>
    public static VaultRescanObligation Begin(VaultRescanObligation obligation, string ownerIdentity)
    {
        RequireOwner(obligation, ownerIdentity);
        if (obligation.State is not VaultRescanState.Required and not VaultRescanState.Failed
            || obligation.Attempt >= MaxAttempts)
        {
            throw new InvalidDataException("vault_rescan_transition_invalid");
        }

        return Seal(obligation with
        {
            State = VaultRescanState.Running,
            Attempt = obligation.Attempt + 1,
            ResultSnapshotSha256 = null
        });
    }

    /// <summary>Retains an unsuccessful attempt and requires another rescan instead of accepting stale state.</summary>
    public static VaultRescanObligation Fail(
        VaultRescanObligation obligation, string ownerIdentity, string reasonCode)
    {
        RequireOwner(obligation, ownerIdentity);
        if (obligation.State != VaultRescanState.Running || !IsReason(reasonCode))
        {
            throw new InvalidDataException("vault_rescan_transition_invalid");
        }

        string[] reasons = obligation.ReasonCodes.Append(reasonCode).Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal).ToArray();
        if (reasons.Length > ArticleVaultEventNormalizer.MaxRawFacts)
        {
            throw new InvalidDataException("vault_rescan_reason_bound_exceeded");
        }

        return Seal(obligation with
        {
            State = VaultRescanState.Failed,
            ReasonCodes = reasons
        });
    }

    /// <summary>
    /// Verifies every supplied current tree leaf and manifest projection is represented exactly once.
    /// Caller-provided tree paths are not a native traversal proof, so the result continues blocking.
    /// </summary>
    public static VaultRescanObligation CompleteStructuralScan(
        ArticleVaultRootManifest root,
        VaultRescanObligation obligation,
        string ownerIdentity,
        IReadOnlyList<string> enumeratedTreePaths,
        IReadOnlyList<VaultFilesystemObservation> observations,
        IReadOnlyList<VaultFilesystemObservation> previousVerifiedInventory)
    {
        RequireOwner(obligation, ownerIdentity);
        ArgumentNullException.ThrowIfNull(enumeratedTreePaths);
        ArgumentNullException.ThrowIfNull(observations);
        if (obligation.State != VaultRescanState.Running
            || enumeratedTreePaths.Count > ArticleVaultEventNormalizer.MaxFiles
            || observations.Count > ArticleVaultEventNormalizer.MaxFiles
            || enumeratedTreePaths.Distinct(StringComparer.Ordinal).Count() != enumeratedTreePaths.Count
            || observations.Any(static item => item is null)
            || observations.Select(static item => item.RelativePath).Distinct(StringComparer.Ordinal).Count() != observations.Count)
        {
            throw new InvalidDataException("vault_rescan_inventory_invalid");
        }

        string[] expected = enumeratedTreePaths.Concat(root.Articles.Select(static item => item.RelativePath))
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        string[] actual = observations.Select(static item => item.RelativePath).Order(StringComparer.Ordinal).ToArray();
        if (!expected.SequenceEqual(actual, StringComparer.Ordinal)
            || observations.Any(item => item.Present != enumeratedTreePaths.Contains(item.RelativePath, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("vault_rescan_inventory_incomplete");
        }

        VaultObservationBatch analysis = ArticleVaultEventNormalizer.Normalize(root, obligation.Binding,
            obligation.WatermarkBefore, [], previousVerifiedInventory, observations, []);
        if (analysis.RescanObligations.Count > 0
            || observations.Where(static item => item.Present).Any(static item => item.Assessment?.State
                != VaultSnapshotAssessmentState.StableCandidate))
        {
            throw new InvalidDataException("vault_rescan_observation_blocked");
        }

        return Seal(obligation with
        {
            State = VaultRescanState.AwaitingNativeVerification,
            ResultSnapshotSha256 = analysis.FilesystemSnapshotSha256
        });
    }

    /// <summary>Checks the closed structural state and privacy-safe digest; it grants no native authority.</summary>
    public static bool Validate(VaultRescanObligation obligation)
    {
        if (obligation is null || obligation.Schema != Schema || obligation.SchemaVersion != 1
            || obligation.Binding is null || obligation.Binding.Scope is null || obligation.WatermarkBefore is null
            || !ArticleVaultManifestValidator.IsIdentity(obligation.Binding.WatchInstanceIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.Binding.Scope.SiteIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.Binding.Scope.VaultIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.Binding.Scope.DeviceIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.Binding.Scope.AgentIdentity)
            || !ArticleVaultManifestValidator.IsSha256(obligation.Binding.Scope.RootIdentitySha256)
            || !ArticleVaultManifestValidator.IsSha256(obligation.Binding.Scope.RootManifestSha256)
            || !Enum.IsDefined(obligation.Binding.Scope.ComparisonPolicy)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.WatermarkBefore.WatchInstanceIdentity)
            || obligation.WatermarkBefore.LastSequence < 0
            || !ArticleVaultManifestValidator.IsSha256(obligation.WatermarkBefore.FilesystemSnapshotSha256)
            || !ArticleVaultManifestValidator.IsIdentity(obligation.OwnerIdentity)
            || obligation.ScopeRelativePath != string.Empty || !Enum.IsDefined(obligation.State)
            || obligation.Attempt is < 0 or > MaxAttempts
            || obligation.State == VaultRescanState.Required && obligation.Attempt != 0
            || obligation.State != VaultRescanState.Required && obligation.Attempt == 0
            || obligation.ReasonCodes is null || obligation.ReasonCodes.Count is 0 or > ArticleVaultEventNormalizer.MaxRawFacts
            || obligation.ReasonCodes.Any(static reason => !IsReason(reason))
            || !obligation.ReasonCodes.SequenceEqual(obligation.ReasonCodes.Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal), StringComparer.Ordinal)
            || obligation.NativeTerminalReceiptSha256 is not null
            || obligation.State == VaultRescanState.AwaitingNativeVerification
                && !ArticleVaultManifestValidator.IsSha256(obligation.ResultSnapshotSha256)
            || obligation.State != VaultRescanState.AwaitingNativeVerification && obligation.ResultSnapshotSha256 is not null
            || !ArticleVaultManifestValidator.IsSha256(obligation.ContentSha256))
        {
            return false;
        }

        return ComputeContentSha256(obligation) == obligation.ContentSha256;
    }

    /// <summary>Replays inventory completeness from the independently held running obligation and tree.</summary>
    public static ArticleVaultValidationResult VerifyStructuralScan(
        ArticleVaultRootManifest root,
        VaultRescanObligation running,
        string ownerIdentity,
        IReadOnlyList<string> enumeratedTreePaths,
        IReadOnlyList<VaultFilesystemObservation> observations,
        IReadOnlyList<VaultFilesystemObservation> previousVerifiedInventory,
        VaultRescanObligation? result)
    {
        try
        {
            if (result is null || !Validate(result))
            {
                return ArticleVaultValidationResult.Invalid("vault_rescan_result_invalid");
            }

            VaultRescanObligation expected = CompleteStructuralScan(root, running, ownerIdentity,
                enumeratedTreePaths, observations, previousVerifiedInventory);
            return result.ContentSha256 == expected.ContentSha256
                ? ArticleVaultValidationResult.Valid()
                : ArticleVaultValidationResult.Invalid("vault_rescan_result_mismatch");
        }
        catch (Exception exception) when (exception is InvalidDataException or ArgumentException
            or System.Text.Json.JsonException)
        {
            return ArticleVaultValidationResult.Invalid("vault_rescan_result_invalid");
        }
    }

    public static string ComputeContentSha256(VaultRescanObligation obligation)
        => Convert.ToHexStringLower(SHA256.HashData(ArticleVaultManifestCodec.SerializeCanonical(
            obligation with
            {
                ContentSha256 = string.Empty
            })));

    private static VaultRescanObligation Seal(VaultRescanObligation obligation)
        => obligation with
        {
            ContentSha256 = ComputeContentSha256(obligation)
        };

    private static void RequireOwner(VaultRescanObligation obligation, string owner)
    {
        if (!Validate(obligation) || obligation.OwnerIdentity != owner)
        {
            throw new InvalidDataException("vault_rescan_owner_or_receipt_invalid");
        }
    }

    private static bool IsReason(string? reason)
        => reason is { Length: > 0 and <= 256 }
            && reason.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_');
}
