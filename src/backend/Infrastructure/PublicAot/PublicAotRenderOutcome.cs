using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotRenderStatus
{
    Success,
    NotFound,
    Gone,
    TransientFailure
}

public readonly record struct PublicAotRenderOutcome(
    PublicAotRenderStatus Status,
    PublicAotCacheEntry? Entry,
    ErrorDetail Error)
{
    public static PublicAotRenderOutcome Success(PublicAotCacheEntry? entry)
        => new(PublicAotRenderStatus.Success, entry, ErrorDetail.None);

    public static PublicAotRenderOutcome NotFound(ErrorDetail error)
        => new(PublicAotRenderStatus.NotFound, null, error);

    public static PublicAotRenderOutcome Gone(ErrorDetail error)
        => new(PublicAotRenderStatus.Gone, null, error);

    public static PublicAotRenderOutcome TransientFailure(ErrorDetail error)
        => new(PublicAotRenderStatus.TransientFailure, null, error);
}
