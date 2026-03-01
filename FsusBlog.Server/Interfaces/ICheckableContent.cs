namespace FsusBlog.Server.Interfaces;

/// <summary>
/// 敏感内容可检阅契约
/// 修复日期: 2026-02-21
/// 职责: 配合 ActionFilter 实现零反射的高性能属性提取
/// </summary>
public interface ICheckableContent
{
    /// <summary>
    /// 获取需要进行敏感词审查的文本内容
    /// </summary>
    string GetTextToCheck();
}