namespace FsusBlog.Server.Infrastructure.Spa;

public sealed record class PublicShellAssetSet(
    string EntryScript,
    IReadOnlyList<string> Stylesheets,
    IReadOnlyList<string> ModulePreloads);

public sealed record class FullAppTakeoverAssetSet(
    IReadOnlyList<string> ModulePreloads,
    IReadOnlyList<string> Stylesheets)
{
    public static FullAppTakeoverAssetSet Empty { get; } = new([], []);
}

public sealed record class SpaAssetSet(
    string EntryScript,
    IReadOnlyList<string> Stylesheets,
    IReadOnlyList<string> ModulePreloads,
    string FrontendAssetVersion,
    bool UsesSourceAssets)
{
    public PublicShellAssetSet PublicShell => new(EntryScript, Stylesheets, ModulePreloads);

    public FullAppTakeoverAssetSet FullAppTakeover { get; init; } = FullAppTakeoverAssetSet.Empty;

    // Production AOT output is bound to this digest through FrontendAssetVersion.
    // Keep it explicit so diagnostics cannot accidentally describe a manifest-only
    // identity as an asset-set identity.
    public string AssetSetDigest { get; init; } = string.Empty;

    public string FrontendBuildIdentity { get; init; } = "missing-manifest";
}
