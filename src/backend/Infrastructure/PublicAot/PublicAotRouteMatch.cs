using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record class PublicAotRouteMatch(
    PublicPageKind Kind,
    PublicPageId PageId,
    string RouteKey,
    string CanonicalPath,
    string Path,
    string QueryString);
