namespace FsusBlog.Server.Contracts.Assets;

/// <summary>
/// Stable content-asset identity. Backed by a canonical UUID and deliberately
/// never interchangeable with a URL or filesystem path.
/// </summary>
public readonly record struct AssetId
{
    private AssetId(Guid value)
    {
        Value = value;
    }

    public Guid Value
    {
        get;
    }

    public static AssetId New()
        => new(Guid.NewGuid());

    public static AssetId FromGuid(Guid value)
        => new(value);

    public static AssetId Parse(string value)
    {
        if (!TryParse(value, out AssetId assetId))
        {
            throw new ArgumentException(
                "AssetId must be a canonical hyphenated UUID (D format).",
                nameof(value));
        }

        return assetId;
    }

    public static bool TryParse(string? value, out AssetId assetId)
    {
        assetId = default;
        if (string.IsNullOrWhiteSpace(value) || !Guid.TryParseExact(value, "D", out Guid guid))
        {
            return false;
        }

        assetId = new AssetId(guid);
        return true;
    }

    public override string ToString()
        => Value.ToString("D");
}
