namespace FsusBlog.Server.Models.Responses;

/// <summary>
/// 统一 API 响应模型
/// 修复日期: 2026-02-23 (重构为 readonly record struct，在所有 API 热路径上实现零分配响应包装)
/// </summary>
/// <typeparam name="T">实际承载的数据类型</typeparam>
public readonly record struct ApiResponse<T>
{
    /// <summary>
    /// 业务状态码 (通常 200 为成功，其他为业务错误)
    /// </summary>
    public int Code { get; }

    /// <summary>
    /// 提示信息 (展示给前端用户的友好提示)
    /// </summary>
    public string Message { get; }

    /// <summary>
    /// 核心数据载荷
    /// </summary>
    public T? Data { get; }

    /// <summary>
    /// 诊断链路 ID，仅错误响应携带
    /// </summary>
    public string? TraceId { get; }

    // 私有构造函数，强制通过静态工厂方法创建
    private ApiResponse(int code, string message, T? data, string? traceId)
    {
        Code = code;
        Message = message;
        Data = data;
        TraceId = traceId;
    }

    // ================== 静态辅助方法 (语法糖) ==================

    /// <summary>
    /// 成功 (带数据)
    /// </summary>
    public static ApiResponse<T> Success(T data, string message = "Success")
    {
        return new ApiResponse<T>(200, message, data, null);
    }

    /// <summary>
    /// 成功 (无数据，例如只提示"删除成功")
    /// </summary>
    public static ApiResponse<T> Success(string message = "Success")
    {
        return new ApiResponse<T>(200, message, default, null);
    }

    /// <summary>
    /// 失败/错误
    /// </summary>
    public static ApiResponse<T> Fail(string message, int code = 400, string? traceId = null)
    {
        return new ApiResponse<T>(code, message, default, traceId);
    }
}

/// <summary>
/// 针对无数据返回场景的非泛型版本
/// 这是一个轻量级的包装器，可以隐式转换为其泛型版本
/// </summary>
public readonly record struct ApiResponse
{
    public int Code { get; }
    public string Message { get; }
    public string? TraceId { get; }

    private ApiResponse(int code, string message, string? traceId)
    {
        Code = code;
        Message = message;
        TraceId = traceId;
    }

    public static ApiResponse Success(string message = "成功")
    {
        return new ApiResponse(200, message, null);
    }

    public static ApiResponse Fail(string message, int code = 400, string? traceId = null)
    {
        return new ApiResponse(code, message, traceId);
    }

    // 核心优化：定义隐式转换运算符。
    // 这使得你可以在需要 ApiResponse<object> 的地方直接返回 ApiResponse，
    // 编译器会自动执行这个无开销的转换，完美解决了 struct 不能继承的问题。
    public static implicit operator ApiResponse<object>(ApiResponse response)
    {
        return response.Code == 200
            ? ApiResponse<object>.Success(response.Message)
            : ApiResponse<object>.Fail(response.Message, response.Code, response.TraceId);
    }

    // 如果需要，也可以定义失败的转换
    public static implicit operator ApiResponse<string>(ApiResponse response)
    {
        return response.Code == 200
           ? ApiResponse<string>.Success(response.Message)
           : ApiResponse<string>.Fail(response.Message, response.Code, response.TraceId);
    }
}
