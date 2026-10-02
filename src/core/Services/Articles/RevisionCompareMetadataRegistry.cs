using System.Collections.Immutable;
using System.Globalization;
using System.Text;

namespace FsusBlog.Core.Services.Articles;

public static class RevisionCompareMetadataRegistry
{
    private static readonly UTF8Encoding s_exactUtf8 = new(false, true);

    private static readonly ImmutableArray<RevisionCompareMetadataDescriptor> s_descriptors =
    [
        new("title", RevisionCompareMetadataValueType.String, false, "exact-utf8", "plain-text", "article-revision.title"),
        new("summary", RevisionCompareMetadataValueType.NullableString, false, "nullable-string-tagged-utf8-v2", "plain-text", "article-revision.summary"),
        new("cover-image-url", RevisionCompareMetadataValueType.NullableString, false, "nullable-string-tagged-utf8-v2", "url", "article-revision.cover-image-url"),
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
    {
        if (value is not null && !ValidNullableStringPayload(value.AsSpan()))
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }

        return Create(fieldId, RevisionCompareMetadataValueType.NullableString, value is null ? "N" : "S" + value);
    }

    /// <summary>
    /// Decodes current nullable-string tags after the caller validates the package
    /// schema. Tags alone do not establish a value's version provenance.
    /// </summary>
    public static string? DecodeNullableString(RevisionCompareMetadataValue value)
    {
        if (value.ValueType != RevisionCompareMetadataValueType.NullableString
            || !ValidCanonicalValue(value.ValueType, value.CanonicalValue))
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }

        return value.CanonicalValue == "N" ? null : value.CanonicalValue[1..];
    }

    internal static bool ValidCanonicalValue(RevisionCompareMetadataValueType valueType, string? canonicalValue)
    {
        if (canonicalValue is null)
        {
            return false;
        }
        if (valueType != RevisionCompareMetadataValueType.NullableString)
        {
            return canonicalValue.Length <= RevisionCompareContract.MaxMetadataValueLength;
        }

        return canonicalValue == "N"
            || (canonicalValue.StartsWith('S') && ValidNullableStringPayload(canonicalValue.AsSpan(1)));
    }

    private static bool ValidNullableStringPayload(ReadOnlySpan<char> payload)
    {
        if (payload.Length > RevisionCompareContract.MaxMetadataValueLength)
        {
            return false;
        }

        try
        {
            _ = s_exactUtf8.GetByteCount(payload);
            return true;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }

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
            || !ValidCanonicalValue(valueType, canonicalValue))
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }

        return new RevisionCompareMetadataValue(fieldId, valueType, canonicalValue, descriptor.Sensitive);
    }
}
