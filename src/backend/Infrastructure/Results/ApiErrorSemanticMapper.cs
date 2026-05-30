using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

internal static class ApiErrorSemanticMapper
{
    public static ErrorCode MapErrorCode(int statusCode)
        => statusCode switch
        {
            StatusCodes.Status400BadRequest => ErrorCode.Validation,
            StatusCodes.Status401Unauthorized => ErrorCode.Unauthorized,
            StatusCodes.Status403Forbidden => ErrorCode.Forbidden,
            StatusCodes.Status404NotFound => ErrorCode.NotFound,
            StatusCodes.Status409Conflict => ErrorCode.Conflict,
            StatusCodes.Status423Locked => ErrorCode.Forbidden,
            _ => ErrorCode.InfraFailure
        };

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

    public static ErrorDetail CreateError(int statusCode, string? message = null, string? traceId = null)
        => ErrorDetail.Create(
            MapErrorCode(statusCode),
            string.IsNullOrWhiteSpace(message) ? MapDefaultMessage(statusCode) : message,
            traceId: traceId);
}
