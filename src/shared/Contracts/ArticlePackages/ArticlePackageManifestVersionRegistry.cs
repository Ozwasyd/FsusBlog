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
/// Closed candidate-codec registry. The legacy (1,1,1), asset-root (2,1,1), and
/// property-payload (3,1,1) identities are registered;
/// it grants no source, permission, migration or complete-package admission.
/// </summary>
public static class ArticlePackageManifestVersionRegistry
{
    private static readonly ArticlePackageManifestVersionRegistration s_current = new(
        new(1, 1, 1), ArticlePackageManifestMigrationDisposition.Identity);
    // Preserve the v1 article-only wire and digest. Assets require a distinct schema and digest
    // domain; neither identity registers a converter between these candidate formats.
    private static readonly ArticlePackageManifestVersionRegistration s_assetCollection = new(
        new(2, 1, 1), ArticlePackageManifestMigrationDisposition.Identity);
    // V3 adds exact article-bound property payloads to the asset root. Component schemas and
    // their v1 domains stay unchanged; no downgrade or cross-tuple converter is registered.
    private static readonly ArticlePackageManifestVersionRegistration s_propertyPayload = new(
        new(3, 1, 1), ArticlePackageManifestMigrationDisposition.Identity);
    private static readonly IReadOnlyList<ArticlePackageManifestVersionRegistration> s_registrations
        = Array.AsReadOnly(new[] { s_current, s_assetCollection, s_propertyPayload });

    public static ArticlePackageManifestVersionRegistration Current => s_current;
    /// <summary>Explicit asset-root format; Current remains the legacy article-only default.</summary>
    public static ArticlePackageManifestVersionRegistration AssetCollection => s_assetCollection;
    /// <summary>Explicit property-payload format, retaining the complete asset-root binding.</summary>
    public static ArticlePackageManifestVersionRegistration PropertyPayload => s_propertyPayload;
    public static IReadOnlyList<ArticlePackageManifestVersionRegistration> Registrations => s_registrations;

    /// <summary>Refuses unregistered tuples and drift from the actual canonical/property implementations.</summary>
    public static bool TryGetRegistration(
        ArticlePackageManifestVersions versions,
        out ArticlePackageManifestVersionRegistration? registration)
    {
        registration = null;
        if ((versions != s_current.Versions && versions != s_assetCollection.Versions && versions != s_propertyPayload.Versions)
            || versions.CanonicalHashVersion != ArticleCanonicalHashV1.HashVersion
            || versions.PropertySchemaVersion != ArticlePropertyValueSnapshot.CurrentSchemaVersion)
        {
            return false;
        }
        registration = versions == s_current.Versions ? s_current
            : versions == s_assetCollection.Versions ? s_assetCollection : s_propertyPayload;
        return true;
    }

    /// <summary>
    /// Returns identity only when both tuples are the same registered format. Lossy requests and every
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
