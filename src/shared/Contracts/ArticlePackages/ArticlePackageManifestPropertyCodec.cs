using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Closed property projection component; supplied coordinates are not persisted observations.</summary>
public sealed class ArticlePackageManifestPropertyCandidate
{
    internal ArticlePackageManifestPropertyCandidate(ArticlePackagePropertyMappingCandidate mapping, string componentDigest)
    {
        Mapping = mapping;
        ComponentDigest = componentDigest;
    }

    public ArticlePackagePropertyMappingCandidate Mapping
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    public ArticlePackageManifestCandidateResult RequirePropertyAuthority()
        => new(false, "article_package_manifest_property_persisted_definition_authority_unavailable");
}

/// <summary>Closed eight-type property component methods of the sole manifest codec, without store or definition authority.</summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const string PropertyComponentDigestDomain = "fsusblog.article-package.manifest-property-candidate.v1";
    // Finite component limits; definition-specific policy remains with the canonical definition owner.
    public const int MaxPropertyTextCharacters = 16384;
    public const int MaxPropertyUrlCharacters = 2048;

    public static ArticlePackageManifestCandidateResult TryCreatePropertyCandidate(
        ArticlePackagePropertyMappingCandidate? mapping,
        out ArticlePackageManifestPropertyCandidate? candidate)
    {
        candidate = null;
        try
        {
            if (mapping is null || !ValidPropertyCoordinates(mapping.SourceCoordinates)
                || !IsDigest(mapping.SourceSnapshotDigest) || !IsDigest(mapping.MappingDigest)
                || !TryCopyMetadataRows(mapping.Properties, ArticlePackagePropertyMappingLimits.MaxDefinitions, out ArticlePackageMappedProperty[] rows))
            {
                return Invalid("article_package_manifest_property_shape_invalid");
            }
            int identities = 0;
            var sourceIds = new HashSet<Guid>();
            var portableIds = new HashSet<ArticlePackageIdentity>();
            foreach (ArticlePackageMappedProperty row in rows)
            {
                if (row.SourceDefinitionId == Guid.Empty || row.SourceSchemaRevision <= 0
                    || !IsDigest(row.SourceDefinitionDigest) || !IsDigest(row.SourceValueDigest) || !IsDigest(row.PortableValueDigest)
                    || !PropertyIdentity(row.PortableDefinition, ArticlePackageIdentityKind.Definition)
                    || !Enum.IsDefined(row.Presence) || (row.Presence == ArticlePropertyValuePresence.Present) != (row.Projection is not null)
                    || row.DefaultApplied && row.Presence == ArticlePropertyValuePresence.Missing
                    || !ValidPropertyProjection(row.Projection, ref identities))
                {
                    return Invalid("article_package_manifest_property_shape_invalid");
                }
                if (!sourceIds.Add(row.SourceDefinitionId) || !portableIds.Add(row.PortableDefinition))
                {
                    return Invalid("article_package_manifest_property_duplicate");
                }
            }
            Array.Sort(rows, static (left, right) => string.CompareOrdinal(left.PortableDefinition.Value, right.PortableDefinition.Value));
            var owned = new ArticlePackagePropertyMappingCandidate(mapping.SourceCoordinates, mapping.SourceSnapshotDigest, rows, mapping.MappingDigest);
            _ = SerializePropertyComponent(owned, new string('0', 64));
            byte[] payload = SerializePropertyComponent(owned, null);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(s_utf8.GetBytes(PropertyComponentDigestDomain + "\0"));
            hash.AppendData(payload);
            candidate = new(owned, Convert.ToHexStringLower(hash.GetHashAndReset()));
            return new(true, null);
        }
        catch (EncoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (DocumentBudgetException)
        {
            return Invalid("article_package_manifest_property_budget_exceeded");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_property_shape_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_manifest_property_shape_invalid");
        }
    }

    public static ArticlePackageManifestCandidateResult TryParsePropertyCandidate(
        ReadOnlySpan<byte> json,
        out ArticlePackageManifestPropertyCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxJsonBytes)
        {
            return Invalid("article_package_manifest_property_budget_exceeded");
        }
        try
        {
            _ = s_utf8.GetCharCount(json);
            if (!HasValidEscapedUnicode(json))
            {
                return Invalid("article_package_manifest_utf8_invalid");
            }
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = MaxReadDepth });
            JsonElement root = document.RootElement;
            if (!CheckMetadataObjectKeys(root, "schemaVersion", "sourceCoordinates", "sourceSnapshotDigest", "mappingDigest", "properties", "componentDigest").IsValid
                || !ReadInt(root, "schemaVersion", out int version) || version != ArticlePackagePropertyMappingCandidate.CurrentSchemaVersion
                || !ReadString(root, "sourceSnapshotDigest", out string? sourceDigest)
                || !ReadString(root, "mappingDigest", out string? mappingDigest) || !ReadString(root, "componentDigest", out string? digest)
                || !IsDigest(digest) || !ReadPropertyCoordinates(root.GetProperty("sourceCoordinates"), out var coordinates))
            {
                return Invalid("article_package_manifest_property_shape_invalid");
            }
            JsonElement values = root.GetProperty("properties");
            if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > ArticlePackagePropertyMappingLimits.MaxDefinitions)
            {
                return Invalid("article_package_manifest_property_shape_invalid");
            }
            var rows = new ArticlePackageMappedProperty[values.GetArrayLength()];
            int index = 0;
            foreach (JsonElement row in values.EnumerateArray())
            {
                if (!ReadPropertyRow(row, out ArticlePackageMappedProperty? parsed))
                {
                    return Invalid("article_package_manifest_property_shape_invalid");
                }
                rows[index++] = parsed!;
            }
            var mapping = new ArticlePackagePropertyMappingCandidate(coordinates!, sourceDigest!, rows, mappingDigest!);
            ArticlePackageManifestCandidateResult result = TryCreatePropertyCandidate(mapping, out var owned);
            if (!result.IsValid)
            {
                return result;
            }
            if (digest != owned!.ComponentDigest)
            {
                return Invalid("article_package_manifest_property_component_digest_mismatch");
            }
            candidate = owned;
            return new(true, null);
        }
        catch (DecoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (JsonException)
        {
            return Invalid("article_package_manifest_property_shape_invalid");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_property_shape_invalid");
        }
    }

    public static byte[] WritePropertyCandidate(ArticlePackageManifestPropertyCandidate candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        ArticlePackageManifestCandidateResult result = TryCreatePropertyCandidate(candidate.Mapping, out var owned);
        if (!result.IsValid || owned!.ComponentDigest != candidate.ComponentDigest)
        {
            throw new ArgumentException("article_package_manifest_property_candidate_invalid", nameof(candidate));
        }
        return SerializePropertyComponent(owned.Mapping, owned.ComponentDigest);
    }

    private static bool ValidPropertyCoordinates(ArticlePropertySnapshotCoordinates value)
        => value is not null && value.DefinitionOwnerUserId is not <= 0
            && MetadataText(value.SiteScope, MaxSiteScopeCharacters, true) && value.ArticleId > 0
            && value.PropertyRevision > 0 && value.ArticleRevisionId > 0
            && value.DraftId.HasValue == value.DraftServerRevision.HasValue
            && value.DraftId is not <= 0 && value.DraftServerRevision is not <= 0 && value.PublicationId is not <= 0
            && !(value.DraftId.HasValue && value.PublicationId.HasValue);

    private static bool PropertyIdentity(ArticlePackageIdentity value, ArticlePackageIdentityKind kind)
        => value.Kind == kind && ArticlePackageIdentity.TryCreate(kind, value.Value, out _).IsValid;

    private static bool ValidPropertyProjection(ArticlePackagePropertyProjection? value, ref int totalIdentities)
    {
        switch (value)
        {
            case null:
                return true;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyTextValue text }:
                return MetadataText(text.Text, MaxPropertyTextCharacters, false);
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyUrlValue url }:
                return MetadataText(url.Url, MaxPropertyUrlCharacters, false);
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyNumberValue or ArticlePropertyBooleanValue }:
                return true;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyDateValue date }:
                return date.Utc.Kind == DateTimeKind.Utc;
            case ArticlePackageSingleOptionPropertyProjection single:
                totalIdentities++;
                return totalIdentities <= ArticlePackagePropertyMappingLimits.MaxProjectedIdentities
                    && PropertyIdentity(single.Option, ArticlePackageIdentityKind.Option);
            case ArticlePackageMultiOptionPropertyProjection multiple:
                return ValidPropertyIdentitySet(multiple.Options, ArticlePackageIdentityKind.Option,
                    ArticlePackagePropertyMappingLimits.MaxOptionsPerValue, ref totalIdentities);
            case ArticlePackageArticleReferencePropertyProjection references:
                return ValidPropertyIdentitySet(references.Articles, ArticlePackageIdentityKind.Article,
                    ArticlePackagePropertyMappingLimits.MaxReferencesPerValue, ref totalIdentities);
            default:
                return false;
        }
    }

    private static bool ValidPropertyIdentitySet(IReadOnlyList<ArticlePackageIdentity> values,
        ArticlePackageIdentityKind kind, int maximum, ref int total)
    {
        if (values.Count > maximum || values.Count > ArticlePackagePropertyMappingLimits.MaxProjectedIdentities - total)
        {
            return false;
        }
        total += values.Count;
        var seen = new HashSet<ArticlePackageIdentity>();
        foreach (ArticlePackageIdentity value in values)
        {
            if (!PropertyIdentity(value, kind) || !seen.Add(value))
            {
                return false;
            }
        }
        return true;
    }

    private static bool ReadPropertyBoolean(JsonElement value, string name, out bool result)
    {
        JsonElement field = value.GetProperty(name);
        result = field.ValueKind == JsonValueKind.True;
        return field.ValueKind is JsonValueKind.True or JsonValueKind.False;
    }

    private static bool ReadPropertyCoordinates(JsonElement row, out ArticlePropertySnapshotCoordinates? value)
    {
        value = null;
        if (!CheckMetadataObjectKeys(row, "definitionOwnerUserId", "siteScope", "articleId", "propertyRevision", "articleRevisionId", "draftId", "draftServerRevision", "publicationId").IsValid
            || !ReadNullableLong(row, "definitionOwnerUserId", out long? owner) || !ReadString(row, "siteScope", out string? site)
            || !ReadInt(row, "articleId", out int article) || !ReadLong(row, "propertyRevision", out long property)
            || !ReadLong(row, "articleRevisionId", out long revision) || !ReadNullableLong(row, "draftId", out long? draft)
            || !ReadNullableLong(row, "draftServerRevision", out long? draftRevision) || !ReadNullableLong(row, "publicationId", out long? publication))
        {
            return false;
        }
        value = new(owner, site!, article, property, revision, draft, draftRevision, publication);
        return ValidPropertyCoordinates(value);
    }

    private static bool ReadPropertyRow(JsonElement row, out ArticlePackageMappedProperty? value)
    {
        value = null;
        if (!CheckMetadataObjectKeys(row, "sourceDefinitionId", "sourceSchemaRevision", "sourceDefinitionDigest", "portableDefinition", "sourceValueDigest", "presence", "defaultApplied", "portableValueDigest", "projection").IsValid
            || !ReadString(row, "sourceDefinitionId", out string? source) || !Guid.TryParseExact(source, "D", out Guid sourceId)
            || sourceId == Guid.Empty || sourceId.ToString("D") != source || !ReadLong(row, "sourceSchemaRevision", out long revision)
            || !ReadString(row, "sourceDefinitionDigest", out string? definitionDigest) || !ReadString(row, "portableDefinition", out string? portable)
            || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Definition, portable, out var identity).IsValid
            || !ReadString(row, "sourceValueDigest", out string? sourceDigest) || !ReadInt(row, "presence", out int presence)
            || presence is < 0 or > 2 || !ReadPropertyBoolean(row, "defaultApplied", out bool defaultApplied)
            || !ReadString(row, "portableValueDigest", out string? valueDigest) || !ReadPropertyProjection(row.GetProperty("projection"), out var projection))
        {
            return false;
        }
        value = new(sourceId, revision, definitionDigest!, identity, sourceDigest!,
            (ArticlePropertyValuePresence)presence, defaultApplied, valueDigest!, projection);
        return true;
    }

    private static bool ReadPropertyProjection(JsonElement row, out ArticlePackagePropertyProjection? value)
    {
        value = null;
        if (row.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (!CheckMetadataObjectKeys(row, "kind", "value").IsValid || !ReadString(row, "kind", out string? kind))
        {
            return false;
        }
        JsonElement payload = row.GetProperty("value");
        switch (kind)
        {
            case "text" when payload.ValueKind == JsonValueKind.String:
                value = new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyTextValue(payload.GetString()!));
                break;
            case "url" when payload.ValueKind == JsonValueKind.String:
                value = new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyUrlValue(payload.GetString()!));
                break;
            case "number" when payload.ValueKind == JsonValueKind.Number && payload.TryGetDecimal(out decimal number)
                && payload.GetRawText() == number.ToString("0.############################", CultureInfo.InvariantCulture):
                value = new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyNumberValue(number));
                break;
            case "boolean" when payload.ValueKind is JsonValueKind.True or JsonValueKind.False:
                value = new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyBooleanValue(payload.GetBoolean()));
                break;
            case "date" when ReadDate(row, "value", out DateTime? utc) && utc.HasValue:
                value = new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyDateValue(utc.Value));
                break;
            case "single-select" when payload.ValueKind == JsonValueKind.String
                && ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Option, payload.GetString(), out var option).IsValid:
                value = new ArticlePackageSingleOptionPropertyProjection(option);
                break;
            case "multi-select" when ReadPropertyIdentitySet(payload, ArticlePackageIdentityKind.Option,
                ArticlePackagePropertyMappingLimits.MaxOptionsPerValue, out var options):
                value = new ArticlePackageMultiOptionPropertyProjection(options);
                break;
            case "article-reference" when ReadPropertyIdentitySet(payload, ArticlePackageIdentityKind.Article,
                ArticlePackagePropertyMappingLimits.MaxReferencesPerValue, out var articles):
                value = new ArticlePackageArticleReferencePropertyProjection(articles);
                break;
            default:
                return false;
        }
        int total = 0;
        return ValidPropertyProjection(value, ref total);
    }

    private static bool ReadPropertyIdentitySet(JsonElement values, ArticlePackageIdentityKind kind,
        int maximum, out ArticlePackageIdentity[] identities)
    {
        identities = [];
        if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > maximum)
        {
            return false;
        }
        identities = new ArticlePackageIdentity[values.GetArrayLength()];
        int index = 0;
        foreach (JsonElement row in values.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.String || !ArticlePackageIdentity.TryCreate(kind, row.GetString(), out var identity).IsValid)
            {
                return false;
            }
            identities[index++] = identity;
        }
        return true;
    }

    private static byte[] SerializePropertyComponent(ArticlePackagePropertyMappingCandidate mapping, string? digest)
    {
        using var stream = new MetadataBudgetStream(MaxJsonBytes);
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", mapping.SchemaVersion);
            writer.WriteStartObject("sourceCoordinates");
            ArticlePropertySnapshotCoordinates coordinates = mapping.SourceCoordinates;
            WriteNullableLong(writer, "definitionOwnerUserId", coordinates.DefinitionOwnerUserId);
            writer.WriteString("siteScope", coordinates.SiteScope);
            writer.WriteNumber("articleId", coordinates.ArticleId);
            writer.WriteNumber("propertyRevision", coordinates.PropertyRevision);
            writer.WriteNumber("articleRevisionId", coordinates.ArticleRevisionId);
            WriteNullableLong(writer, "draftId", coordinates.DraftId);
            WriteNullableLong(writer, "draftServerRevision", coordinates.DraftServerRevision);
            WriteNullableLong(writer, "publicationId", coordinates.PublicationId);
            writer.WriteEndObject();
            writer.WriteString("sourceSnapshotDigest", mapping.SourceSnapshotDigest);
            writer.WriteString("mappingDigest", mapping.MappingDigest);
            writer.WriteStartArray("properties");
            foreach (ArticlePackageMappedProperty row in mapping.Properties)
            {
                writer.WriteStartObject();
                writer.WriteString("sourceDefinitionId", row.SourceDefinitionId.ToString("D"));
                writer.WriteNumber("sourceSchemaRevision", row.SourceSchemaRevision);
                writer.WriteString("sourceDefinitionDigest", row.SourceDefinitionDigest);
                writer.WriteString("portableDefinition", row.PortableDefinition.Value);
                writer.WriteString("sourceValueDigest", row.SourceValueDigest);
                writer.WriteNumber("presence", (int)row.Presence);
                writer.WriteBoolean("defaultApplied", row.DefaultApplied);
                writer.WriteString("portableValueDigest", row.PortableValueDigest);
                writer.WritePropertyName("projection");
                WritePropertyProjection(writer, row.Projection);
                writer.WriteEndObject();
                writer.Flush();
            }
            writer.WriteEndArray();
            if (digest is not null)
            {
                writer.WriteString("componentDigest", digest);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static void WritePropertyProjection(Utf8JsonWriter writer, ArticlePackagePropertyProjection? projection)
    {
        if (projection is null)
        {
            writer.WriteNullValue();
            return;
        }
        writer.WriteStartObject();
        switch (projection)
        {
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyTextValue text }:
                writer.WriteString("kind", "text");
                writer.WriteString("value", text.Text);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyUrlValue url }:
                writer.WriteString("kind", "url");
                writer.WriteString("value", url.Url);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyNumberValue number }:
                writer.WriteString("kind", "number");
                writer.WritePropertyName("value");
                writer.WriteRawValue(number.Number.ToString("0.############################", CultureInfo.InvariantCulture));
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyBooleanValue boolean }:
                writer.WriteString("kind", "boolean");
                writer.WriteBoolean("value", boolean.Boolean);
                break;
            case ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyDateValue date }:
                writer.WriteString("kind", "date");
                writer.WriteString("value", date.Utc.ToString(UtcFormat, CultureInfo.InvariantCulture));
                break;
            case ArticlePackageSingleOptionPropertyProjection single:
                writer.WriteString("kind", "single-select");
                writer.WriteString("value", single.Option.Value);
                break;
            case ArticlePackageMultiOptionPropertyProjection multiple:
                WritePropertyIdentityArray(writer, "multi-select", multiple.Options);
                break;
            case ArticlePackageArticleReferencePropertyProjection references:
                WritePropertyIdentityArray(writer, "article-reference", references.Articles);
                break;
            default:
                throw new ArgumentException("article_package_manifest_property_shape_invalid");
        }
        writer.WriteEndObject();
    }

    private static void WritePropertyIdentityArray(Utf8JsonWriter writer, string kind, IReadOnlyList<ArticlePackageIdentity> values)
    {
        writer.WriteString("kind", kind);
        writer.WriteStartArray("value");
        foreach (ArticlePackageIdentity value in values)
        {
            writer.WriteStringValue(value.Value);
        }
        writer.WriteEndArray();
    }
}
