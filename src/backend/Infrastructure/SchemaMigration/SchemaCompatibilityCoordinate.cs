using System.Globalization;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public readonly record struct SchemaCompatibilityCoordinate : IComparable<SchemaCompatibilityCoordinate>
{
    public const string MinimumValue = "00000000000000-000000000000";
    public const string MaximumValue = "99999999999999-ffffffffffff";
    public const string LegacyMinimumValue = "00000000-legacy-bootstrap";
    public const string LegacyMaximumValue = "99999999-online-schema-v1";

    private static readonly Regex s_legacyPattern = new(
        "^[0-9]{8}-[a-z0-9][a-z0-9-]{2,119}$",
        RegexOptions.CultureInvariant);

    private SchemaCompatibilityCoordinate(string value, string sortKey, bool legacy)
    {
        Value = value;
        SortKey = sortKey;
        IsLegacy = legacy;
    }

    public string Value
    {
        get;
    }

    public bool IsLegacy
    {
        get;
    }

    private string SortKey
    {
        get;
    }

    public static SchemaCompatibilityCoordinate Minimum
    {
        get;
    } =
        new(MinimumValue, MinimumValue, legacy: false);

    public static SchemaCompatibilityCoordinate Maximum
    {
        get;
    } =
        new(MaximumValue, MaximumValue, legacy: false);

    public static SchemaCompatibilityCoordinate FromReleaseId(ReleaseId releaseId)
    {
        string value = releaseId.Value;
        return new SchemaCompatibilityCoordinate(value, value, legacy: false);
    }

    public static SchemaCompatibilityCoordinate ParseManifest(string value)
    {
        if (string.Equals(value, MinimumValue, StringComparison.Ordinal))
        {
            return Minimum;
        }
        if (string.Equals(value, MaximumValue, StringComparison.Ordinal))
        {
            return Maximum;
        }

        return FromReleaseId(ReleaseId.Parse(value));
    }

    public static SchemaCompatibilityCoordinate FromLegacyMetadata(string value)
    {
        if (string.Equals(value, LegacyMinimumValue, StringComparison.Ordinal))
        {
            return Minimum;
        }
        if (string.Equals(value, LegacyMaximumValue, StringComparison.Ordinal))
        {
            return Maximum;
        }
        if (!s_legacyPattern.IsMatch(value) || !TryParseLegacyDate(value.AsSpan(0, 8)))
        {
            throw new ArgumentException("Legacy schema compatibility coordinate is invalid.", nameof(value));
        }

        string sortKey = $"{value[..8]}000000-000000000000~legacy~{value[9..]}";
        return new SchemaCompatibilityCoordinate(value, sortKey, legacy: true);
    }

    public static SchemaCompatibilityCoordinate ParsePersisted(string value)
    {
        try
        {
            return ParseManifest(value);
        }
        catch (ArgumentException)
        {
            return FromLegacyMetadata(value);
        }
    }

    public int CompareTo(SchemaCompatibilityCoordinate other)
        => string.CompareOrdinal(SortKey, other.SortKey);

    public override string ToString() => Value;

    private static bool TryParseLegacyDate(ReadOnlySpan<char> value)
        => DateOnly.TryParseExact(
            value,
            "yyyyMMdd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out _);
}
