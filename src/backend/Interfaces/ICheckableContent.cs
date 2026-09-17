namespace FsusBlog.Server.Interfaces;

/// <summary>
/// Exposes content to the moderation filter without reflection-based property discovery.
/// </summary>
public interface ICheckableContent
{
    /// <summary>
    /// 获取需要进行敏感词审查的文本内容
    /// </summary>
    string GetTextToCheck();
}
