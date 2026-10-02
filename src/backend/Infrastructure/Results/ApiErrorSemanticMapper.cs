using System.Collections.Frozen;

using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

internal static class ApiErrorSemanticMapper
{
    // Lookup and observation enumerate these exact entries. The unknown-status
    // fallback preserves runtime behavior, but is not an enumerated public set.
    public static FrozenDictionary<int, ErrorCode> PublicStatusMappings
    {
        get;
    } =
        new Dictionary<int, ErrorCode>
        {
            { StatusCodes.Status400BadRequest, ErrorCode.Validation },
            { StatusCodes.Status401Unauthorized, ErrorCode.Unauthorized },
            { StatusCodes.Status403Forbidden, ErrorCode.Forbidden },
            { StatusCodes.Status404NotFound, ErrorCode.NotFound },
            { StatusCodes.Status405MethodNotAllowed, ErrorCode.InfraFailure },
            { StatusCodes.Status406NotAcceptable, ErrorCode.InfraFailure },
            { StatusCodes.Status409Conflict, ErrorCode.Conflict },
            { StatusCodes.Status410Gone, ErrorCode.InfraFailure },
            { StatusCodes.Status411LengthRequired, ErrorCode.InfraFailure },
            { StatusCodes.Status413PayloadTooLarge, ErrorCode.InfraFailure },
            { StatusCodes.Status415UnsupportedMediaType, ErrorCode.InfraFailure },
            { StatusCodes.Status416RangeNotSatisfiable, ErrorCode.InfraFailure },
            { StatusCodes.Status422UnprocessableEntity, ErrorCode.InfraFailure },
            { StatusCodes.Status423Locked, ErrorCode.Forbidden },
            { StatusCodes.Status426UpgradeRequired, ErrorCode.InfraFailure },
            { StatusCodes.Status428PreconditionRequired, ErrorCode.InfraFailure },
            { StatusCodes.Status429TooManyRequests, ErrorCode.InfraFailure },
            { StatusCodes.Status500InternalServerError, ErrorCode.InfraFailure },
            { StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure }
        }.ToFrozenDictionary();

    public static ErrorCode MapErrorCode(int statusCode)
        => PublicStatusMappings.TryGetValue(statusCode, out ErrorCode errorCode)
            ? errorCode
            : ErrorCode.InfraFailure;

    public static int MapStatusCode(in ErrorDetail error)
        => error.Code switch
        {
            ErrorCode.Validation => StatusCodes.Status400BadRequest,
            ErrorCode.Unauthorized => StatusCodes.Status401Unauthorized,
            ErrorCode.Forbidden => StatusCodes.Status403Forbidden,
            ErrorCode.NotFound => StatusCodes.Status404NotFound,
            ErrorCode.Conflict => StatusCodes.Status409Conflict,
            ErrorCode.InfraFailure => StatusCodes.Status500InternalServerError,
            _ => StatusCodes.Status500InternalServerError
        };

    public static string MapDefaultMessage(int statusCode)
        => statusCode switch
        {
            StatusCodes.Status400BadRequest => "Bad Request",
            StatusCodes.Status401Unauthorized => "Unauthorized",
            StatusCodes.Status403Forbidden => "Forbidden",
            StatusCodes.Status404NotFound => "Not Found",
            StatusCodes.Status409Conflict => "Conflict",
            StatusCodes.Status423Locked => "Locked",
            _ => "Request failed"
        };

    public static ErrorDetail CreateError(int statusCode, string? message = null, string? traceId = null, string? details = null)
        => ErrorDetail.Create(
            MapErrorCode(statusCode),
            string.IsNullOrWhiteSpace(message) ? MapDefaultMessage(statusCode) : message,
            details,
            traceId);
}
