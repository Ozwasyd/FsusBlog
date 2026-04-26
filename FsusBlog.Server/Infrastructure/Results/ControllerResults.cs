using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Results;

public static class ControllerResults
{
    public static ActionResult<ApiResponse> BadRequest(string message, string? traceId = null, int code = 400)
        => new BadRequestObjectResult(ApiResponse.Fail(message, code, traceId));

    public static ActionResult<ApiResponse> NotFound(string message = "资源不存在", string? traceId = null)
        => new NotFoundObjectResult(ApiResponse.Fail(message, 404, traceId));

    public static ActionResult<ApiResponse> Conflict(string message, string? traceId = null)
        => new ConflictObjectResult(ApiResponse.Fail(message, 409, traceId));

    public static ActionResult<ApiResponse> Unauthorized(string message = "未授权", string? traceId = null)
        => new ObjectResult(ApiResponse.Fail(message, 401, traceId)) { StatusCode = 401 };

    public static ActionResult<ApiResponse> Forbidden(string message = "权限不足", string? traceId = null)
        => new ObjectResult(ApiResponse.Fail(message, 403, traceId)) { StatusCode = 403 };

    public static ActionResult<ApiResponse> Status(int statusCode, string message, string? traceId = null)
        => new ObjectResult(ApiResponse.Fail(message, statusCode, traceId)) { StatusCode = statusCode };

    public static ActionResult<ApiResponse<T>> NotFound<T>(string message = "资源不存在", string? traceId = null)
        => new NotFoundObjectResult(ApiResponse<T>.Fail(message, 404, traceId));

    public static ActionResult<ApiResponse<T>> BadRequest<T>(string message, string? traceId = null, int code = 400)
        => new BadRequestObjectResult(ApiResponse<T>.Fail(message, code, traceId));

    public static ActionResult<ApiResponse<T>> Status<T>(int statusCode, string message, string? traceId = null)
        => new ObjectResult(ApiResponse<T>.Fail(message, statusCode, traceId)) { StatusCode = statusCode };

    public static ActionResult<ApiResponse<T>> Conflict<T>(string message, string? traceId = null)
        => new ConflictObjectResult(ApiResponse<T>.Fail(message, 409, traceId));

    public static ActionResult<ApiResponse<T>> Unauthorized<T>(string message = "未授权", string? traceId = null)
        => new ObjectResult(ApiResponse<T>.Fail(message, 401, traceId)) { StatusCode = 401 };

    public static ActionResult<ApiResponse<T>> Forbidden<T>(string message = "权限不足", string? traceId = null)
        => new ObjectResult(ApiResponse<T>.Fail(message, 403, traceId)) { StatusCode = 403 };
}
