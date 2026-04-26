using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Results;

public static class EndpointFilterResults
{
    public static IResult FromActionResult(IActionResult actionResult, HttpContext context)
        => actionResult switch
        {
            UnauthorizedObjectResult unauthorized => Microsoft.AspNetCore.Http.Results.Json(
                unauthorized.Value ?? ApiResponse.Fail("Unauthorized", 401, context.TraceIdentifier),
                statusCode: 401),
            BadRequestObjectResult badRequest => Microsoft.AspNetCore.Http.Results.BadRequest(
                badRequest.Value ?? ApiResponse.Fail("Bad Request", 400, context.TraceIdentifier)),
            ObjectResult { StatusCode: 403 } forbidden => Microsoft.AspNetCore.Http.Results.Json(
                forbidden.Value ?? ApiResponse.Fail("权限不足", 403, context.TraceIdentifier),
                statusCode: 403),
            ObjectResult objectResult when objectResult.StatusCode is int statusCode => Microsoft.AspNetCore.Http.Results.Json(
                objectResult.Value ?? ApiResponse.Fail("请求失败", statusCode, context.TraceIdentifier),
                statusCode: statusCode),
            _ => Microsoft.AspNetCore.Http.Results.StatusCode(500)
        };
}
