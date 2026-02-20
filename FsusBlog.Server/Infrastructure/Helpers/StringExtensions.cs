namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// 字符串扩展工具
/// </summary>
public static class StringExtensions
{
    /// <summary>
    /// 将字符串转换为首字母大写，其余小写的格式 (类似 Title Case)
    /// 示例: "fSUS" -> "Fsus"
    /// </summary>
    public static string ToTitleCase(this string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;

        // 使用 .NET 高性能 API 直接操作内存缓冲区
        return string.Create(input.Length, input, (span, state) =>
        {
            // 1. 处理首字母
            span[0] = char.ToUpperInvariant(state[0]);

            // 2. 将剩余部分转为小写填充到缓冲区
            state.AsSpan(1).ToLowerInvariant(span[1..]);
        });
    }

    /// <summary>
    /// 仅将首字母转为大写，不触动后续字符的大小写状态
    /// 示例: "fSUS" -> "FSUS"
    /// </summary>
    public static string FirstCharToUpper(this string? input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;
        if (input.Length == 1) return char.ToUpperInvariant(input[0]).ToString();

        // 仅 1 次 Substring，比全量 LowerCase 更省资源
        return char.ToUpperInvariant(input[0]) + input[1..];
    }

    /// <summary>
    /// 安全截断字符串并添加省略号
    /// </summary>
    public static string Truncate(this string? value, int maxLength, string suffix = "...")
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= maxLength ? value : string.Concat(value.AsSpan(0, maxLength), suffix);
    }
}