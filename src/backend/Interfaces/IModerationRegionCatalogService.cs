using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IModerationRegionCatalogService
{
    ModerationRegionCatalogSnapshot CurrentSnapshot
    {
        get;
    }
    string? LastError
    {
        get;
    }
    ModerationRegionCatalogSnapshot GetRuntimeSnapshot();
    ModerationEffectivePolicyPreview PreviewEffectivePolicy(
        string regionCode,
        IReadOnlyList<ModerationPolicyTemplateRule>? operatorOverrides = null);
}
