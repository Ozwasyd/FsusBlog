using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// Provides invariant casing and bounded truncation helpers.
/// </summary>
public static class StringExtensions
{
    /// <summary>
    /// 将字符串转换为首字母大写，其余小写的格式 (类似 Title Case)
    /// 示例: "fSUS" -> "Fsus"
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string ToTitleCase(this string? input)
    {
        // 使用 IsNullOrEmpty 性能略高于 IsNullOrWhiteSpace，且足以防御越界
        if (string.IsNullOrEmpty(input))
            return string.Empty;

        // string.Create writes casing changes into the returned string's final buffer.
        return string.Create(input.Length, input, (span, state) =>
        {
            // 1. 处理首字母
            span[0] = char.ToUpperInvariant(state[0]);

            // 2. 将剩余部分转为小写填充到缓冲区
            if (span.Length > 1)
            {
                state.AsSpan(1).ToLowerInvariant(span[1..]);
            }
        });
    }

    /// <summary>
    /// 仅将首字母转为大写，不触动后续字符的大小写状态
    /// 示例: "fSUS" -> "FSUS"
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string FirstCharToUpper(this string? input)
    {
        if (string.IsNullOrEmpty(input))
            return string.Empty;

        // Preserve reference identity when the first character already satisfies the contract.
        if (char.IsUpper(input[0]))
            return input;

        // string.Create writes the transformed value into its final string buffer.
        return string.Create(input.Length, input, (span, state) =>
        {
            span[0] = char.ToUpperInvariant(state[0]);
            if (span.Length > 1)
            {
                state.AsSpan(1).CopyTo(span[1..]);
            }
        });
    }

    /// <summary>
    /// 安全截断字符串并添加省略号
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string Truncate(this string? value, int maxLength, string suffix = "...")
    {
        // 增加安全防御：如果要求截断的长度小于等于 0，直接返回空
        if (string.IsNullOrEmpty(value) || maxLength <= 0)
            return string.Empty;

        // Span-based Concat creates only the returned truncated string.
        return value.Length <= maxLength ? value : string.Concat(value.AsSpan(0, maxLength), suffix);
    }
}
