namespace FsusBlog.Server.Models.Responses;

/// <summary>
/// 通用分页结果载体
/// 修复日期: 2026-02-23 (升级为 record class 以获得值语义，使用集合表达式初始化)
/// </summary>
/// <typeparam name="T">列表项的数据类型 (通常应为 struct 以实现零分配)</typeparam>
public record class PageResult<T>
{
    /// <summary>
    /// 总记录数
    /// </summary>
    public int Total { get; set; }

    /// <summary>
    /// 当前页的数据列表
    /// </summary>
    public List<T> Items { get; set; } = [];
}