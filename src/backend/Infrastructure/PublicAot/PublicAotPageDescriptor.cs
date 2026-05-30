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
}
