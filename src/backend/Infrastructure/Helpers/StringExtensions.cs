using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// 字符串扩展工具
/// 修复日期: 2026-02-23 (引入快速路径检查避免不必要的分配，重构 FirstCharToUpper 使用 string.Create 消除 Substring 开销)
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
        if (string.IsNullOrEmpty(input)) return string.Empty;

        // 使用 .NET 高性能 API 直接操作内存缓冲区，仅分配最终字符串一次
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
        if (string.IsNullOrEmpty(input)) return string.Empty;

        // 核心优化 1：快速路径 (Fast Path)
        // 如果首字母已经是大写，直接返回原字符串引用，实现绝对的零内存分配和零处理时间
        if (char.IsUpper(input[0])) return input;

        // 核心优化 2：彻底消灭 Substring 和拼接分配
        // 原代码会产生两个托管堆对象。改用 string.Create 结合 Span.CopyTo 直接进行底层内存复制
        return string.Create(input.Length, input, (span, state) =>
        {
            span[0] = char.ToUpperInvariant(state[0]);
            if (span.Length > 1)
            {
                // 内存块复制，极速且无额外分配
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
        if (string.IsNullOrEmpty(value) || maxLength <= 0) return string.Empty;

        // 注：string.Concat(ReadOnlySpan<char>, ReadOnlySpan<char>) 在 .NET 8+ 底层是
        // 经过高度定制和 SIMD 优化的，它会精确计算长度并执行单次 fast-path 内存复制，
        // 其性能处于物理极限，因此这里保留此写法。
        return value.Length <= maxLength ? value : string.Concat(value.AsSpan(0, maxLength), suffix);
    }
}