namespace FsusBlog.Server.Contracts.Assets;

/// <summary>
/// Normalized relative storage key for a content asset. The key is the only
/// stable locator between <see cref="AssetRecord"/> and storage: it never
/// contains a root path, traversal segments, backslash, NUL, or characters
/// that would make the public-URL round trip ambiguous.
/// </summary>
public readonly record struct AssetStorageKey
{
    public const int MaxLength = 512;
    public const int MaxSegmentLength = 255;

    private AssetStorageKey(string value)
    {
        Value = value;
    }

    public string Value
    {
        get;
    }

    public static AssetStorageKey Parse(string value)
    {
        if (!TryParse(value, out AssetStorageKey storageKey))
        {
            throw new ArgumentException(
                "AssetStorageKey must be a normalized relative key without root, traversal, backslash, NUL, or unsafe URL characters.",
                nameof(value));
        }

        return storageKey;
    }

    public static bool TryParse(string? value, out AssetStorageKey storageKey)
    {
        storageKey = default;
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaxLength)
        {
            return false;
        }

        if (value.IndexOf('\0') >= 0
            || value.IndexOf('\\') >= 0
            || value.IndexOf('%') >= 0
            || Path.IsPathRooted(value)
            || IsDriveQualified(value))
        {
            return false;
        }

        string[] segments = value.Split('/');
        if (segments.Length == 0)
        {
            return false;
        }

        foreach (string segment in segments)
        {
            if (segment.Length == 0
                || segment.Length > MaxSegmentLength
                || segment is "." or "..")
            {
                return false;
            }

            foreach (char character in segment)
            {
                if (!char.IsAsciiLetterOrDigit(character)
                    && character is not '.' and not '_' and not '-')
                {
                    return false;
                }
            }
        }

        storageKey = new AssetStorageKey(string.Join('/', segments));
        return true;
    }

    private static bool IsDriveQualified(string value)
        => value.Length >= 2
            && char.IsAsciiLetter(value[0])
            && value[1] == ':';

    public override string ToString()
        => Value;
}
