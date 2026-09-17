using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// Formats timestamps for wire contracts that require invariant RFC 822 output.
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

        // The fixed-width contract lets TryFormat write directly into the returned string.
        return string.Create(Rfc822StringLength, utcTime, (span, dt) =>
        {
            dt.TryFormat(span, out _, "R");
        });
    }
}
