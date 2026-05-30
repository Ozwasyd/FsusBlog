using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// 时间工具类
/// 修复日期: 2026-02-23 (利用常量长度与 string.Create 实现绕过 Culture 查找的极限格式化)
/// </summary>
public static class TimeUtils
{
    // RFC1123 / RFC822 ("R" 格式) 的输出长度恒定为 29 个字符
    // 例如: "Fri, 27 Feb 2026 08:12:34 GMT"
    private const int Rfc822StringLength = 29;

    /// <summary>
    /// 将 DateTime 转换为 RSS 2.0 要求的 RFC 822 格式
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string ToRfc822(DateTime dateTime)
    {
        // 确保转换为 UTC 时间以符合标准
        DateTime utcTime = dateTime.ToUniversalTime();

        // 终极优化：直接分配精确长度的字符串，并调用底层的 TryFormat 将内容写入 Span<char>。
        // 这彻底斩断了 ToString() 内部的通用状态机流转和多余的虚方法调用开销。
        return string.Create(Rfc822StringLength, utcTime, (span, dt) =>
        {
            // "R" 格式是内建的快速路径，搭配精确大小的 Span，耗时趋近于绝对下限
            dt.TryFormat(span, out _, "R");
        });
    }
}