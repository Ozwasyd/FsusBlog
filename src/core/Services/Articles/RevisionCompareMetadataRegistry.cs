using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Core.Services.Articles;

public static class RevisionCompareMetadataRegistry
{
    private static readonly ImmutableArray<RevisionCompareMetadataDescriptor> s_descriptors =
    [
        new("title", RevisionCompareMetadataValueType.String, false, "exact-utf8", "plain-text", "article-revision.title"),
        new("summary", RevisionCompareMetadataValueType.NullableString, false, "canonical-json-string-or-null", "plain-text", "article-revision.summary"),
        new("cover-image-url", RevisionCompareMetadataValueType.NullableString, false, "canonical-json-string-or-null", "url", "article-revision.cover-image-url"),
        new("category-id", RevisionCompareMetadataValueType.Int32, false, "invariant-decimal", "stable-id", "article-revision.category-id"),
        new("tag-ids", RevisionCompareMetadataValueType.Int32List, false, "sorted-invariant-decimal", "stable-id-list", "article-revision.tag-ids"),
        new("status", RevisionCompareMetadataValueType.Int32, false, "invariant-decimal", "closed-enum", "article-lifecycle.status"),
        new("scheduled-publish-at", RevisionCompareMetadataValueType.NullableInstant, false, "utc-roundtrip-or-null", "utc-instant", "article-lifecycle.scheduled-publish-at")
    ];

    private static readonly IReadOnlyDictionary<string, RevisionCompareMetadataDescriptor> s_byId =
        s_descriptors.ToDictionary(static item => item.FieldId, StringComparer.Ordinal);

    public static ImmutableArray<RevisionCompareMetadataDescriptor> Descriptors => s_descriptors;

    public static bool TryGet(string fieldId, out RevisionCompareMetadataDescriptor descriptor)
        => s_byId.TryGetValue(fieldId, out descriptor!);

    public static RevisionCompareMetadataValue String(string fieldId, string value)
        => Create(fieldId, RevisionCompareMetadataValueType.String, value);

    public static RevisionCompareMetadataValue NullableString(string fieldId, string? value)
        => Create(fieldId, RevisionCompareMetadataValueType.NullableString, JsonSerializer.Serialize(value));

    public static RevisionCompareMetadataValue Int32(string fieldId, int value)
        => Create(fieldId, RevisionCompareMetadataValueType.Int32, value.ToString(CultureInfo.InvariantCulture));

    public static RevisionCompareMetadataValue Int32List(string fieldId, IEnumerable<int> values)
    {
        var ids = new SortedSet<int>();
        foreach (int value in values)
        {
            if (value <= 0 || !ids.Add(value) || ids.Count > RevisionCompareContract.MaxMetadataValueLength / 2)
            {
                throw new RevisionCompareContractException("revision_compare_metadata_invalid");
            }
        }
        return Create(
            fieldId,
            RevisionCompareMetadataValueType.Int32List,
            string.Join(',', ids.Select(static value => value.ToString(CultureInfo.InvariantCulture))));
    }

    public static RevisionCompareMetadataValue NullableInstant(string fieldId, DateTime? value)
        => Create(
            fieldId,
            RevisionCompareMetadataValueType.NullableInstant,
            value.HasValue ? Utc(value.Value).ToString("O", CultureInfo.InvariantCulture) : "null");

    internal static bool ValidValue(RevisionCompareMetadataValue value)
    {
        if (value.CanonicalValue is null
            || value.CanonicalValue.Length > RevisionCompareContract.MaxMetadataValueLength
            || !TryGet(value.FieldId, out RevisionCompareMetadataDescriptor descriptor)
            || descriptor.ValueType != value.ValueType
            || descriptor.Sensitive != value.Sensitive)
        {
            return false;
        }

        string canonical = value.CanonicalValue;
        switch (value.ValueType)
        {
            case RevisionCompareMetadataValueType.String:
                return true;
            case RevisionCompareMetadataValueType.NullableString:
                try
                {
                    return string.Equals(JsonSerializer.Serialize(JsonSerializer.Deserialize<string>(canonical)),
                        canonical, StringComparison.Ordinal);
                }
                catch (JsonException)
                {
                    return false;
                }
            case RevisionCompareMetadataValueType.Int32:
                return CanonicalInt32(canonical, out int number)
                    && (value.FieldId != "status" || ArticleStatusTransitionPolicy.IsDefined(number));
            case RevisionCompareMetadataValueType.Int32List:
                if (canonical.Length == 0)
                {
                    return true;
                }
                int previous = 0;
                foreach (string item in canonical.Split(','))
                {
                    if (!CanonicalInt32(item, out int id) || id <= previous)
                    {
                        return false;
                    }
                    previous = id;
                }
                return true;
            case RevisionCompareMetadataValueType.NullableInstant:
                return canonical == "null"
                    || (DateTime.TryParseExact(canonical, "O", CultureInfo.InvariantCulture,
                        DateTimeStyles.RoundtripKind, out DateTime instant)
                        && instant.Kind == DateTimeKind.Utc
                        && string.Equals(instant.ToString("O", CultureInfo.InvariantCulture), canonical,
                            StringComparison.Ordinal));
            default:
                return false;
        }
    }

    private static bool CanonicalInt32(string value, out int number)
        => int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out number)
            && string.Equals(number.ToString(CultureInfo.InvariantCulture), value, StringComparison.Ordinal);

    private static DateTime Utc(DateTime value)
        => value.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value.ToUniversalTime();

    private static RevisionCompareMetadataValue Create(
        string fieldId,
        RevisionCompareMetadataValueType valueType,
        string canonicalValue)
    {
        if (!TryGet(fieldId, out RevisionCompareMetadataDescriptor descriptor)
            || descriptor.ValueType != valueType
            || canonicalValue.Length > RevisionCompareContract.MaxMetadataValueLength)
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }

        var value = new RevisionCompareMetadataValue(fieldId, valueType, canonicalValue, descriptor.Sensitive);
        if (!ValidValue(value))
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }
        return value;
    }
}
