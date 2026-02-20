
namespace FsusBlog.Server.Models.Responses;

/// <summary>
/// 统一 API 响应模型
/// </summary>
/// <typeparam name="T">实际承载的数据类型</typeparam>
public class ApiResponse<T>
{
    /// <summary>
    /// 业务状态码 (通常 200 为成功，其他为业务错误)
    /// </summary>
    public int Code { get; set; }

    /// <summary>
    /// 提示信息 (展示给前端用户的友好提示)
    /// </summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>
    /// 核心数据载荷
    /// </summary>
    public T? Data { get; set; }

    // ================== 静态辅助方法 (语法糖) ==================

    /// <summary>
    /// 成功 (带数据)
    /// </summary>
    public static ApiResponse<T> Success(T data, string message = "Success")
    {
        return new ApiResponse<T>
        {
            Code = 200,
            Message = message,
            Data = data
        };
    }

    /// <summary>
    /// 成功 (无数据，例如只提示"删除成功")
    /// </summary>
    public static ApiResponse<T> Success(string message = "Success")
    {
        return new ApiResponse<T>
        {
            Code = 200,
            Message = message,
            Data = default
        };
    }

    /// <summary>
    /// 失败/错误
    /// </summary>
    public static ApiResponse<T> Fail(string message, int code = 400)
    {
        return new ApiResponse<T>
        {
            Code = code,
            Message = message,
            Data = default
        };
    }
}

/// <summary>
/// 针对无数据返回场景的非泛型版本
/// </summary>
public class ApiResponse : ApiResponse<object>
{
    // 在这里重新定义静态方法，隐藏父类的同名方法 (使用 new 关键字)

    public new static ApiResponse Success(string message = "成功")
    {
        return new ApiResponse
        {
            Code = 200,
            Message = message,
            Data = null
        };
    }

    public new static ApiResponse Fail(string message, int code = 400)
    {
        return new ApiResponse
        {
            Code = code,
            Message = message,
            Data = null
        };
    }
}
