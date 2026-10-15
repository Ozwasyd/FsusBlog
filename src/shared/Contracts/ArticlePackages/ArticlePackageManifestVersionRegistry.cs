using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Manifest, canonical-hash and property-schema versions considered as one tuple.</summary>
public readonly record struct ArticlePackageManifestVersions(
    int SchemaVersion,
    int CanonicalHashVersion,
    int PropertySchemaVersion);

/// <summary>Candidate-codec disposition only; identity does not admit a product migration.</summary>
public enum ArticlePackageManifestMigrationDisposition
{
    Refused = 0,
    Identity = 1
}

/// <summary>Immutable registration of an implemented candidate tuple and its identity disposition.</summary>
public sealed class ArticlePackageManifestVersionRegistration
{
    internal ArticlePackageManifestVersionRegistration(
        ArticlePackageManifestVersions versions,
        ArticlePackageManifestMigrationDisposition disposition)
    {
        Versions = versions;
        Disposition = disposition;
    }

    public ArticlePackageManifestVersions Versions
    {
        get;
    }
    public ArticlePackageManifestMigrationDisposition Disposition
    {
        get;
    }
}

/// <summary>
/// Closed candidate-codec registry. Only the implemented (1,1,1) identity is registered;
/// it grants no source, permission, migration or complete-package admission.
/// </summary>
public static class ArticlePackageManifestVersionRegistry
{
    private static readonly ArticlePackageManifestVersionRegistration s_current = new(
        new(1, 1, 1), ArticlePackageManifestMigrationDisposition.Identity);
    private static readonly IReadOnlyList<ArticlePackageManifestVersionRegistration> s_registrations
        = Array.AsReadOnly(new[] { s_current });

    public static ArticlePackageManifestVersionRegistration Current => s_current;
    public static IReadOnlyList<ArticlePackageManifestVersionRegistration> Registrations => s_registrations;

    /// <summary>Refuses unregistered tuples and drift from the actual canonical/property implementations.</summary>
    public static bool TryGetRegistration(
        ArticlePackageManifestVersions versions,
        out ArticlePackageManifestVersionRegistration? registration)
    {
        registration = null;
        if (versions != s_current.Versions
            || versions.CanonicalHashVersion != ArticleCanonicalHashV1.HashVersion
            || versions.PropertySchemaVersion != ArticlePropertyValueSnapshot.CurrentSchemaVersion)
        {
            return false;
        }
        registration = s_current;
        return true;
    }

    /// <summary>
    /// Returns identity only for the registered source and target tuple. Lossy requests and every
    /// other source/target combination are refused; no historical or future converter is implied.
    /// </summary>
    public static ArticlePackageManifestMigrationDisposition GetDisposition(
        ArticlePackageManifestVersions source,
        ArticlePackageManifestVersions target,
        bool requiresLossyConversion = false)
    {
        if (requiresLossyConversion
            || !TryGetRegistration(source, out ArticlePackageManifestVersionRegistration? registration)
            || !TryGetRegistration(target, out _)
            || source != target)
        {
            return ArticlePackageManifestMigrationDisposition.Refused;
        }
        return registration!.Disposition;
    }
}
