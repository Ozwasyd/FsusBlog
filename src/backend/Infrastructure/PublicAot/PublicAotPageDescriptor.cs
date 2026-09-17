using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal sealed record PublicAotPageDescriptor(
    PublicPageKind Kind,
    string? StaticPath,
    string? FixedRouteKey,
    string DefaultTitle,
    string StoredPageName,
    string? CanonicalFixedPath
)
{
    internal PublicPageId PageId => PublicAotPageIdentity.ToPageId(Kind);

    internal string HydrationKind => PublicAotPageIdentity.ToHydrationKind(Kind);

    internal bool SeoEligible => PublicPageRegistry.GetRequired(PageId).SeoEligible;

    internal bool AotShellReady => PublicPageRegistry.GetRequired(PageId).AotShellReady;

    internal bool RequiresUserState => PublicPageRegistry.GetRequired(PageId).RequiresUserState;

    internal string FallbackBehavior => PublicPageRegistry.GetRequired(PageId).FallbackBehavior;
}
