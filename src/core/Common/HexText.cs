namespace FsusBlog.Core.Common;

public static class HexText
{
    public static bool IsSha256Hex(string? value)
        => IsFixedLengthHex(value, 64);

    public static bool IsFixedLengthHex(string? value, int length)
        => value is not null && value.Length == length && IsHex(value.AsSpan());

    public static bool IsHex(ReadOnlySpan<char> value)
    {
        if (value.Length == 0)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            if (!Uri.IsHexDigit(value[i]))
            {
                return false;
            }
        }

        return true;
    }
}
