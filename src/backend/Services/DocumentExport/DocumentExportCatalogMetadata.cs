namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Declared contract facts, without a tool admission or source-privacy claim.</summary>
internal sealed record DocumentExportCatalogProviderMetadata(
    string FormatId,
    string ProviderId,
    string ProviderVersion,
    string OutputMediaType,
    string OutputExtension,
    bool ImplementationDeclared,
    IReadOnlyList<string> LayoutProfiles,
    IReadOnlyList<string> ThemeProfiles,
    IReadOnlyList<DocumentExportFeatureSupport> Features,
    DocumentExportResourceBudgets Budgets,
    DocumentExportDeliveryPolicy Delivery,
    bool RuntimeAvailabilityKnown,
    bool Available,
    string AvailabilityReason);

internal sealed record DocumentExportCatalogMetadata(
    string ReadingStyleAuthorityId,
    string ReadingStyleAuthorityDigest,
    IReadOnlyList<DocumentExportCatalogProviderMetadata> Providers);

/// <summary>
/// Projects the original closed registry and reading profiles. No runtime
/// readiness reader exists, so declared implementations cannot become available.
/// The endpoint binding authenticates callers before reading these metadata.
/// </summary>
internal static class DocumentExportCatalogMetadataProjection
{
    internal static DocumentExportCatalogMetadata Read()
    {
        IReadOnlyList<string> layouts = Array.AsReadOnly([DocumentExportReadingStyleAuthority.LayoutProfile]);
        IReadOnlyList<string> themes = Array.AsReadOnly(
        [
            DocumentExportReadingStyleAuthority.LightThemeProfile,
            DocumentExportReadingStyleAuthority.DarkThemeProfile
        ]);
        DocumentExportCatalogProviderMetadata[] providers = DocumentExportContractCatalog.FormatIds
            .Select(DocumentExportContractCatalog.RequireProvider)
            .Select(provider => new DocumentExportCatalogProviderMetadata(
                provider.FormatId, provider.ProviderId, provider.ProviderVersion,
                provider.OutputMediaType, provider.OutputExtension, provider.ImplementationAvailable,
                layouts, themes, provider.Features, provider.Budgets, provider.Delivery,
                RuntimeAvailabilityKnown: false, Available: false,
                AvailabilityReason: "runtime-readiness-authority-unavailable"))
            .ToArray();
        return new(DocumentExportReadingStyleAuthority.AuthorityId,
            DocumentExportReadingStyleAuthority.AuthorityDigest, Array.AsReadOnly(providers));
    }
}
