namespace FsusBlog.Server.Infrastructure.Helpers;

public static class TimeUtils
{
    /// <summary>
    /// 将 DateTime 转换为 RSS 2.0 要求的 RFC 822 格式
    /// </summary>
    public static string ToRfc822(DateTime dateTime)
    {
        // 确保转换为 UTC 时间以符合标准
        return dateTime.ToUniversalTime().ToString("R");
    }
}
