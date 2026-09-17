using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotRenderStatus
{
    Success,
    PermanentRedirect,
    NotFound,
    Gone,
    TransientFailure
}

public readonly record struct PublicAotRenderOutcome(
    PublicAotRenderStatus Status,
    PublicAotCacheEntry? Entry,
    ErrorDetail Error,
    string? RedirectPath)
{
    public static PublicAotRenderOutcome Success(PublicAotCacheEntry? entry)
        => new(PublicAotRenderStatus.Success, entry, ErrorDetail.None, null);

    public static PublicAotRenderOutcome PermanentRedirect(string redirectPath)
        => new(PublicAotRenderStatus.PermanentRedirect, null, ErrorDetail.None, redirectPath);

    public static PublicAotRenderOutcome NotFound(ErrorDetail error)
        => new(PublicAotRenderStatus.NotFound, null, error, null);

    public static PublicAotRenderOutcome Gone(ErrorDetail error)
        => new(PublicAotRenderStatus.Gone, null, error, null);

    public static PublicAotRenderOutcome TransientFailure(ErrorDetail error)
        => new(PublicAotRenderStatus.TransientFailure, null, error, null);
}
