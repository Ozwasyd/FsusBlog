using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Infrastructure.Results;

public static class ApiResults
{
    public static Ok<ApiResponse<T>> Ok<T>(T data, string message = "Success")
        => TypedResults.Ok(ApiResponse<T>.Success(data, message));

    public static Ok<ApiResponse> Ok(string message = "成功")
        => TypedResults.Ok(ApiResponse.Success(message));

    public static BadRequest<ApiResponse> BadRequest(string message, int code = 400, string? traceId = null)
        => TypedResults.BadRequest(ApiResponse.Fail(message, code, traceId));

    public static NotFound<ApiResponse> NotFound(string message = "资源不存在", string? traceId = null)
        => TypedResults.NotFound(ApiResponse.Fail(message, 404, traceId));

    public static Conflict<ApiResponse> Conflict(string message, string? traceId = null)
        => TypedResults.Conflict(ApiResponse.Fail(message, 409, traceId));

    public static JsonHttpResult<ApiResponse> Status(int statusCode, string message, string? traceId = null)
        => TypedResults.Json(ApiResponse.Fail(message, statusCode, traceId), statusCode: statusCode);

    public static JsonHttpResult<ApiResponse> Unauthorized(string message = "未授权", string? traceId = null)
        => Status(401, message, traceId);

    public static JsonHttpResult<ApiResponse> Forbidden(string message = "权限不足", string? traceId = null)
        => Status(403, message, traceId);

    public static JsonHttpResult<ApiResponse> Unprocessable(string message, string? traceId = null)
        => Status(422, message, traceId);

    public static JsonHttpResult<ApiResponse> FromError(in ErrorDetail error)
        => Status(
            MapStatusCode(error),
            string.IsNullOrWhiteSpace(error.Message) ? "请求失败" : error.Message,
            error.TraceId);

    public static Results<Ok<ApiResponse<T>>, JsonHttpResult<ApiResponse>> FromResult<T>(in Result<T> result, string message = "Success")
        => result.IsSuccess && result.Value is not null
            ? Ok(result.Value, message)
            : FromError(result.Error);

    public static Results<Ok<ApiResponse>, JsonHttpResult<ApiResponse>> FromResult(in Result result, string message = "成功")
        => result.IsSuccess
            ? Ok(message)
            : FromError(result.Error);

    public static int MapStatusCode(in ErrorDetail error)
        => error.Code switch
        {
            ErrorCode.Validation => 400,
            ErrorCode.Unauthorized => 401,
            ErrorCode.Forbidden => 403,
            ErrorCode.NotFound => 404,
            ErrorCode.Conflict => 409,
            ErrorCode.InfraFailure => 500,
            _ => 500
        };
}
