namespace FsusBlog.Server.Models.Responses;

/// <summary>
/// Represents one page of results and the total matching record count.
/// </summary>
/// <typeparam name="T">The list item contract.</typeparam>
public record class PageResult<T>
{
    /// <summary>
    /// 总记录数
    /// </summary>
    public int Total
    {
        get; set;
    }

    /// <summary>
    /// 当前页的数据列表
    /// </summary>
    public List<T> Items { get; set; } = [];
}
