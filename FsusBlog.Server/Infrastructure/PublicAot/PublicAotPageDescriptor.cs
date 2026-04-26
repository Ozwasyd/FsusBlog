using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal sealed record PublicAotPageDescriptor(
    PublicPageKind Kind,
    PublicPageId PageId,
    string HydrationKind,
    string? StaticPath,
    string? FixedRouteKey,
    string DefaultTitle,
    string StoredPageName,
    string? CanonicalFixedPath
);
