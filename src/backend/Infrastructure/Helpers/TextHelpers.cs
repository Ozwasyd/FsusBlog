namespace FsusBlog.Server.Infrastructure.Helpers;

public static class TextHelpers
{
    public static string? NormalizeNullable(string? value)
        => TrimOrNull(value);

    public static string? NormalizeNullable(string? value, int maxLength)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(maxLength);

        string? normalized = TrimOrNull(value);
        if (normalized is null)
        {
            return null;
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    public static string? NormalizeModeToken(string? value)
        => NormalizeModeToken(value, int.MaxValue);

    public static string? NormalizeModeToken(string? value, int maxLength)
    {
        string? normalized = LowerTrimmed(value, maxLength);
        if (normalized is null)
        {
            return null;
        }

        return normalized.Contains('-') ? normalized.Replace('-', '_') : normalized;
    }

    public static string? TrimOrNull(string? value)
    {
        if (value is null)
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length == 0 ? null : trimmed;
    }

    public static string TrimOrEmpty(string? value)
    {
        if (value is null)
        {
            return string.Empty;
        }

        string trimmed = value.Trim();
        return trimmed.Length == 0 ? string.Empty : trimmed;
    }

    public static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value;

    public static string? LowerTrimmed(string? value)
        => LowerTrimmed(value, int.MaxValue);

    public static string? LowerTrimmed(string? value, int maxLength)
    {
        string? normalized = NormalizeNullable(value, maxLength);
        return ToLowerInvariantIfNeeded(normalized);
    }

    public static string? LowerTrimmedModeToken(string? value)
        => NormalizeModeToken(value);

    public static string? LowerTrimmedModeToken(string? value, int maxLength)
        => NormalizeModeToken(value, maxLength);

    private static string? ToLowerInvariantIfNeeded(string? value)
    {
        if (value is null)
        {
            return null;
        }

        for (int i = 0; i < value.Length; i++)
        {
            if (char.ToLowerInvariant(value[i]) != value[i])
            {
                return value.ToLowerInvariant();
            }
        }

        return value;
    }
}
