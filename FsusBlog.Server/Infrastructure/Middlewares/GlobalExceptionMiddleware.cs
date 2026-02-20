using FsusBlog.Server.Models.Responses;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Middlewares;

// 注入 IHostEnvironment 以便在运行时判断环境，而不是编译时
public class GlobalExceptionMiddleware(RequestDelegate _next, ILogger<GlobalExceptionMiddleware> _logger, IHostEnvironment _env)
{
    // 1. 【性能】静态复用配置，且使用驼峰命名
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            // 2. 【逻辑】如果响应头已经发出（例如流式传输中途报错），不能再修改状态码
            if (context.Response.HasStarted)
            {
                _logger.LogWarning("响应已开始传输，无法执行全局异常处理。异常: {Message}", ex.Message);
                throw; // 必须重新抛出，让 Kestrel 中断连接
            }

            await HandleExceptionAsync(context, ex);
        }
    }

    private async Task HandleExceptionAsync(HttpContext context, Exception ex)
    {
        // 3. 【特殊处理】用户主动取消请求（如刷新页面、关闭浏览器）
        if (ex is OperationCanceledException)
        {
            // 这种情况下，客户端已经断开，写入 Response 没有意义
            _logger.LogInformation("请求被客户端取消: {Path}", context.Request.Path);
            return;
        }

        // 4. 【状态码映射】
        int statusCode = ex switch
        {
            ArgumentException => (int)HttpStatusCode.BadRequest,        // 400
            UnauthorizedAccessException => (int)HttpStatusCode.Unauthorized, // 401
            KeyNotFoundException => (int)HttpStatusCode.NotFound,       // 404
            NotImplementedException => (int)HttpStatusCode.NotImplemented, // 501
            // 如果你有自定义业务异常，请在这里添加，例如：
            // BusinessException => (int)HttpStatusCode.BadRequest, 
            _ => (int)HttpStatusCode.InternalServerError                // 500
        };

        // 5. 【日志分级】
        // 500+ 记录 Error (需要报警)，4xx 记录 Warning (无需报警)
        if (statusCode >= 500)
        {
            _logger.LogError(ex, "服务器异常 [500]：{Path}", context.Request.Path);
        }
        else
        {
            _logger.LogWarning("业务拦截 [{Code}]：{Message} (Path: {Path})", statusCode, ex.Message, context.Request.Path);
        }

        // 6. 【响应构建】
        context.Response.ContentType = "application/json";
        context.Response.StatusCode = statusCode;

        // 7. 【环境隔离】
        // 开发环境显示堆栈，生产环境显示友好提示
        // 使用注入的 _env.IsDevelopment() 比 #if DEBUG 更灵活
        string errorMsg;
        if (statusCode >= 500 && !_env.IsDevelopment())
        {
            errorMsg = "服务器内部错误，请稍后重试";
        }
        else
        {
            // 4xx 错误或开发环境下，直接显示真实错误信息
            errorMsg = ex.Message;
        }

        var response = ApiResponse.Fail(errorMsg, statusCode);

        // 8. 直接序列化到 Response.Body 流
        // 避免了先生成 string (内存分配) 再写入 stream 的开销
        await JsonSerializer.SerializeAsync(context.Response.Body, response, _jsonOptions);
    }
}