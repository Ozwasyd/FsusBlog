namespace FsusBlog.Server.Infrastructure.Spa;

public sealed record class SpaAssetSet(
    string EntryScript,
    IReadOnlyList<string> Stylesheets,
    IReadOnlyList<string> ModulePreloads,
    string FrontendAssetVersion,
    bool UsesSourceAssets);
