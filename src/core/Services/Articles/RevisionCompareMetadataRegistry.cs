using System.Collections.Immutable;
using System.Globalization;

namespace FsusBlog.Core.Services.Articles;

public static class RevisionCompareMetadataRegistry
{
    private static readonly ImmutableArray<RevisionCompareMetadataDescriptor> s_descriptors =
    [
        new("title", RevisionCompareMetadataValueType.String, false, "exact-utf8", "plain-text", "article-revision.title"),
        new("summary", RevisionCompareMetadataValueType.NullableString, false, "exact-utf8-or-null", "plain-text", "article-revision.summary"),
        new("cover-image-url", RevisionCompareMetadataValueType.NullableString, false, "exact-utf8-or-null", "url", "article-revision.cover-image-url"),
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
        => Create(fieldId, RevisionCompareMetadataValueType.NullableString, value ?? "null");

    public static RevisionCompareMetadataValue Int32(string fieldId, int value)
        => Create(fieldId, RevisionCompareMetadataValueType.Int32, value.ToString(CultureInfo.InvariantCulture));

    public static RevisionCompareMetadataValue Int32List(string fieldId, IEnumerable<int> values)
        => Create(
            fieldId,
            RevisionCompareMetadataValueType.Int32List,
            string.Join(',', values.Distinct().Order().Select(static value => value.ToString(CultureInfo.InvariantCulture))));

    public static RevisionCompareMetadataValue NullableInstant(string fieldId, DateTime? value)
        => Create(
            fieldId,
            RevisionCompareMetadataValueType.NullableInstant,
            value.HasValue ? value.Value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : "null");

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

        return new RevisionCompareMetadataValue(fieldId, valueType, canonicalValue, descriptor.Sensitive);
    }
}
