using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Helpers;

public class DigitCount
{
    /// <summary>
    /// 金融级位数计算逻辑：彻底免疫 long.MinValue 溢出风险，并正确处理符号位长度
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int GetDigitCount(long n)
    {
        int sign = 0;
        ulong un;
        if (n < 0)
        {
            sign = 1;
            un = (ulong)(-(n + 1)) + 1;
        }
        else
        {
            un = (ulong)n;
        }

        if (un < 10UL)
            return 1 + sign;
        if (un < 100UL)
            return 2 + sign;
        if (un < 1000UL)
            return 3 + sign;
        if (un < 10000UL)
            return 4 + sign;
        if (un < 100000UL)
            return 5 + sign;
        if (un < 1000000UL)
            return 6 + sign;
        if (un < 10000000UL)
            return 7 + sign;
        if (un < 100000000UL)
            return 8 + sign;
        if (un < 1000000000UL)
            return 9 + sign;
        if (un < 10000000000UL)
            return 10 + sign;
        if (un < 100000000000UL)
            return 11 + sign;
        if (un < 1000000000000UL)
            return 12 + sign;
        if (un < 10000000000000UL)
            return 13 + sign;
        if (un < 100000000000000UL)
            return 14 + sign;
        if (un < 1000000000000000UL)
            return 15 + sign;
        if (un < 10000000000000000UL)
            return 16 + sign;
        if (un < 100000000000000000UL)
            return 17 + sign;
        if (un < 1000000000000000000UL)
            return 18 + sign;
        if (un < 10000000000000000000UL)
            return 19 + sign;
        return 20 + sign;
    }
}
