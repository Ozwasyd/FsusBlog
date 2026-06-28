using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using System.Diagnostics;
using System.Net;

namespace FsusBlog.Server.Infrastructure.Middlewares;

// 注入 IHostEnvironment 以便在运行时判断环境，而不是编译时
// 修复日期: 2026-02-23 (声明为 partial 以引入 LoggerMessage 源生成器消除日志分配，增强序列化中断韧性)
public partial class GlobalExceptionMiddleware(RequestDelegate _next, ILogger<GlobalExceptionMiddleware> _logger, IHostEnvironment _env)
{
    private const string BadRequestMessage = "请求参数非法";

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
                LogResponseHasStarted(ex.Message);
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
            LogClientCanceled(context.Request.Path.Value ?? string.Empty);
            return;
        }

        // 4. 【状态码映射】
        ErrorDetail error = CreateClientSafeError(ex);
        int statusCode = error.Code == ErrorCode.InfraFailure && ex is NotImplementedException
            ? (int)HttpStatusCode.NotImplemented
            : BinaryResults.MapStatusCode(error);

        string path = context.Request.Path.Value ?? string.Empty;

        // 5. 【日志分级】
        // 500+ 记录 Error (需要报警)，4xx 记录 Warning (无需报警)
        if (statusCode >= 500)
        {
            LogServerError(ex, path);
        }
        else
        {
            string logMessage = ex is BadHttpRequestException ? BadRequestMessage : ex.Message;
            LogBusinessWarning(statusCode, logMessage, path);
        }

        // 6. 【环境隔离】
        // 开发环境显示堆栈，生产环境显示友好提示
        // 使用注入的 _env.IsDevelopment() 比 #if DEBUG 更灵活
        string errorMsg;
        if (statusCode >= 500 && !_env.IsDevelopment())
        {
            errorMsg = "服务器内部错误，请稍后重试";
        }
        else if (statusCode >= 500 && _env.IsDevelopment())
        {
            errorMsg = ex.Message;
        }
        else
        {
            // 4xx 错误使用 client-safe 文案，避免把内部异常消息回显给调用方。
            errorMsg = error.Message;
        }

        IBinaryEnvelopePolicy envelopePolicy = context.RequestServices?.GetService<IBinaryEnvelopePolicy>() ?? new BinaryEnvelopePolicy();
        await envelopePolicy.WriteApiErrorAsync(
            context,
            context.Response.Body,
            ErrorDetail.Create(error.Code, errorMsg, traceId: Activity.Current?.Id),
            statusCode);
    }

    private static ErrorDetail CreateClientSafeError(Exception ex)
        => ex switch
        {
            BadHttpRequestException => ErrorDetail.Create(ErrorCode.Validation, BadRequestMessage),
            ArgumentException => ErrorDetail.Create(ErrorCode.Validation, BadRequestMessage),
            UnauthorizedAccessException => ErrorDetail.Create(ErrorCode.Unauthorized, "未授权访问"),
            KeyNotFoundException => ErrorDetail.Create(ErrorCode.NotFound, "资源不存在"),
            NotImplementedException => ErrorDetail.Create(ErrorCode.InfraFailure, "功能暂不可用"),
            _ => ErrorDetail.Create(ErrorCode.InfraFailure, "服务器内部错误，请稍后重试")
        };

    // ====================================================================
    // 高性能日志源生成器声明区 (彻底消灭装箱与 object[] 分配)
    // ====================================================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "响应已开始传输，无法执行全局异常处理。异常: {Message}")]
    private partial void LogResponseHasStarted(string message);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Information,
        Message = "请求被客户端取消: {Path}")]
    private partial void LogClientCanceled(string path);

    [LoggerMessage(
        EventId = 3,
        Level = LogLevel.Error,
        Message = "服务器异常 [500]：{Path}")]
    private partial void LogServerError(Exception ex, string path);

    [LoggerMessage(
        EventId = 4,
        Level = LogLevel.Warning,
        Message = "业务拦截 [{StatusCode}]：{Message} (Path: {Path})")]
    private partial void LogBusinessWarning(int statusCode, string message, string path);
}
