namespace FsusBlog.Server.Models.Responses;

/// <summary>
/// 通用分页结果载体
/// </summary>
/// <typeparam name="T">列表项的数据类型</typeparam>
public class PageResult<T>
{
    /// <summary>
    /// 总记录数
    /// </summary>
    public int Total { get; set; }

    /// <summary>
    /// 当前页的数据列表
    /// </summary>
    public List<T> Items { get; set; } = new();
}
