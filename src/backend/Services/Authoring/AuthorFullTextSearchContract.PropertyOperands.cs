using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Typed property input extension of the sole author content search contract.</summary>
public static partial class AuthorFullTextSearchContract
{
    public const string PropertyOperandSchema = "fsusblog.author-search-property-operand.v1";

    /// <summary>
    /// Binds typed values to an observed definition. This does not admit a query, authorize
    /// source/target access, or establish a current index. Strings in AuthorSearchClause
    /// remain unavailable as property operands; no text grammar or query engine is added.
    /// </summary>
    public static AuthorSearchPropertyOperand CreatePropertyOperand(
        ArticlePropertyDefinition definition,
        string operatorId,
        IEnumerable<ArticlePropertyTypedValue> values)
    {
        ArgumentNullException.ThrowIfNull(definition);
        ArgumentNullException.ThrowIfNull(values);
        ImmutableArray<ArticlePropertyTypedValue> held = values.Take(MaxQueryClauses + 1).ToImmutableArray();
        var operand = new AuthorSearchPropertyOperand(PropertyOperandSchema, QuerySchema, TokenizerVersion,
            definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest,
            definition.ValueType, operatorId, held, string.Empty);
        ValidatePropertyOperandShape(operand, definition);
        return operand with
        {
            ContentDigest = PropertyOperandDigest(operand)
        };
    }

    /// <summary>Pure identity/shape/digest validation, including ordered numeric/UTC pairs.</summary>
    public static void ValidatePropertyOperand(
        AuthorSearchPropertyOperand operand,
        ArticlePropertyDefinition definition)
    {
        ValidatePropertyOperandShape(operand, definition);
        Require(operand.ContentDigest == PropertyOperandDigest(operand),
            "author_search_property_operand_digest_invalid");
    }

    private static void ValidatePropertyOperandShape(
        AuthorSearchPropertyOperand operand,
        ArticlePropertyDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(operand);
        ArgumentNullException.ThrowIfNull(definition);
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        Require(definition.Status == ArticlePropertyDefinitionStatus.Active && definition.Filterable,
            "author_search_property_not_filterable");
        Require(operand.Schema == PropertyOperandSchema && operand.QuerySchema == QuerySchema
            && operand.TokenizerVersion == TokenizerVersion,
            "author_search_property_operand_version_invalid");
        Require(operand.DefinitionId == definition.DefinitionId
            && operand.DefinitionSchemaRevision == definition.SchemaRevision
            && operand.DefinitionDigest == definition.ContentDigest
            && operand.ValueType == definition.ValueType,
            "author_search_property_operand_definition_stale");
        ArticlePropertyDefinitionContract.ValidateOperator(operand.OperatorId, definition.ValueType);
        Require(operand.OperatorId is not "url.host" and not "url.scheme",
            "author_search_property_operand_semantics_unavailable");
        Require(!operand.Values.IsDefault, "author_search_property_operand_shape_invalid");
        int count = operand.OperatorId switch
        {
            "value.is-missing" or "value.is-present" => 0,
            "number.between" or "date.between" => 2,
            _ => 1
        };
        Require(operand.OperatorId == "select.any-of" && definition.ValueType == ArticlePropertyValueType.SingleSelect
            ? operand.Values.Length is >= 1 and <= MaxQueryClauses
            : operand.Values.Length == count, "author_search_property_operand_arity_invalid");
        foreach (ArticlePropertyTypedValue value in operand.Values)
        {
            Require(value is not null, "author_search_property_operand_missing");
            AuthorSearchPropertyValueProjection.ValidateTypedShape(definition, value,
                allowReferenceAlternatives: operand.OperatorId == "reference.any-of");
        }
        if (operand.OperatorId == "select.any-of" && definition.ValueType == ArticlePropertyValueType.SingleSelect)
        {
            Require(operand.Values.Select(static value => ((ArticlePropertySingleSelectValue)value).OptionId)
                .Distinct().Count() == operand.Values.Length, "author_search_property_operand_set_invalid");
        }
        if (operand.OperatorId == "number.between")
        {
            Require(((ArticlePropertyNumberValue)operand.Values[0]).Number
                <= ((ArticlePropertyNumberValue)operand.Values[1]).Number,
                "author_search_property_operand_range_invalid");
        }
        if (operand.OperatorId == "date.between")
        {
            Require(((ArticlePropertyDateValue)operand.Values[0]).Utc
                <= ((ArticlePropertyDateValue)operand.Values[1]).Utc,
                "author_search_property_operand_range_invalid");
        }
    }

    /// <summary>
    /// Refuses undefined comparison semantics before reading any corpus. The actual
    /// comparison still delegates to the sole original projection owner, never a copy.
    /// </summary>
    internal static void ValidatePropertyPredicate(AuthorSearchPropertyOperand operand, ArticlePropertyDefinition definition)
    {
        ValidatePropertyOperand(operand, definition);
        Require(operand.OperatorId is "value.is-missing" or "value.is-present"
            or "number.equals" or "number.less-than" or "number.less-than-or-equal"
            or "number.greater-than" or "number.greater-than-or-equal"
            or "date.before" or "date.on-or-before" or "date.after" or "date.on-or-after"
            or "boolean.equals" or "select.any-of" or "reference.any-of" or "url.equals"
            || operand.OperatorId == "select.equals" && definition.ValueType == ArticlePropertyValueType.SingleSelect
            || operand.OperatorId == "reference.equals" && definition.Cardinality == ArticlePropertyCardinality.Single,
            "author_search_property_comparison_semantics_unavailable");
        Require(!operand.Values.OfType<ArticlePropertyArticleReferenceValue>().Any(value => value.ArticleIds.Count != 0),
            "author_search_property_reference_authority_unavailable");
    }

    private static int PropertyOperandCharacters(AuthorSearchPropertyOperand operand)
    {
        if (operand.Values.IsDefault)
        {
            return MaxQueryCharacters + 1;
        }
        long characters = 0;
        foreach (ArticlePropertyTypedValue value in operand.Values)
        {
            characters += value switch
            {
                ArticlePropertyTextValue text => text.Text?.Length ?? MaxQueryCharacters + 1,
                ArticlePropertyUrlValue url => url.Url?.Length ?? MaxQueryCharacters + 1,
                ArticlePropertyMultiSelectValue multiple => multiple.OptionIds.Count * 36L,
                ArticlePropertyArticleReferenceValue references => references.ArticleIds.Count * 20L,
                _ => 36
            };
            if (characters > MaxQueryCharacters)
            {
                return MaxQueryCharacters + 1;
            }
        }
        return (int)characters;
    }

    private static string PropertyOperandDigest(AuthorSearchPropertyOperand operand)
        => Digest(JsonSerializer.Serialize(new
        {
            operand.Schema,
            operand.QuerySchema,
            operand.TokenizerVersion,
            operand.DefinitionId,
            operand.DefinitionSchemaRevision,
            operand.DefinitionDigest,
            operand.ValueType,
            operand.OperatorId,
            Values = operand.Values.Select(value => ArticlePropertyValueDigest.ComputeValue(
                new ArticlePropertyValueInput(operand.DefinitionId, operand.DefinitionSchemaRevision,
                    operand.DefinitionDigest, ArticlePropertyValuePresence.Present, value))).ToArray()
        }));
}

/// <summary>
/// Immutable typed input owned by AuthorFullTextSearchContract, using the existing eight sealed
/// payloads and sole definition-owned operator table. Query execution requires this operand
/// inside a validated v4 Property clause; a detached operand is not a query or a permission grant.
/// Presence operators have zero payloads; between has two ordered values; single-select any-of
/// accepts bounded distinct option values; other operators have one typed scalar or typed ID set.
/// Comparison semantics absent from the authority stay unsupported.
/// </summary>
[JsonConverter(typeof(AuthorSearchPropertyOperandJsonConverter))]
public sealed record AuthorSearchPropertyOperand(
    string Schema,
    string QuerySchema,
    string TokenizerVersion,
    Guid DefinitionId,
    long DefinitionSchemaRevision,
    string DefinitionDigest,
    ArticlePropertyValueType ValueType,
    string OperatorId,
    ImmutableArray<ArticlePropertyTypedValue> Values,
    string ContentDigest);

/// <summary>
/// SDK JSON binding for the original eight immutable payloads, discriminated only by
/// the original ValueType. This is wire binding for the same operand, not a text/query
/// parser or value authority. Missing scalar members never become zero/false defaults.
/// </summary>
internal sealed class AuthorSearchPropertyOperandJsonConverter : JsonConverter<AuthorSearchPropertyOperand>
{
    public AuthorSearchPropertyOperandJsonConverter()
    {
    }

    public override AuthorSearchPropertyOperand Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using JsonDocument document = JsonDocument.ParseValue(ref reader);
        JsonElement root = document.RootElement;
        RequireFields(root, "Schema", "QuerySchema", "TokenizerVersion", "DefinitionId", "DefinitionSchemaRevision",
            "DefinitionDigest", "ValueType", "OperatorId", "Values", "ContentDigest");
        ArticlePropertyValueType type = root.GetProperty("ValueType").Deserialize<ArticlePropertyValueType>();
        JsonElement values = root.GetProperty("Values");
        if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() > AuthorFullTextSearchContract.MaxQueryClauses)
        {
            throw new JsonException("author_search_property_operand_shape_invalid");
        }
        var held = ImmutableArray.CreateBuilder<ArticlePropertyTypedValue>();
        foreach (JsonElement value in values.EnumerateArray())
        {
            held.Add(ReadValue(type, value));
        }
        return new(root.GetProperty("Schema").GetString()!, root.GetProperty("QuerySchema").GetString()!,
            root.GetProperty("TokenizerVersion").GetString()!, root.GetProperty("DefinitionId").GetGuid(),
            root.GetProperty("DefinitionSchemaRevision").GetInt64(), root.GetProperty("DefinitionDigest").GetString()!,
            type, root.GetProperty("OperatorId").GetString()!, held.ToImmutable(), root.GetProperty("ContentDigest").GetString()!);
    }

    public override void Write(Utf8JsonWriter writer, AuthorSearchPropertyOperand value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("Schema", value.Schema);
        writer.WriteString("QuerySchema", value.QuerySchema);
        writer.WriteString("TokenizerVersion", value.TokenizerVersion);
        writer.WriteString("DefinitionId", value.DefinitionId);
        writer.WriteNumber("DefinitionSchemaRevision", value.DefinitionSchemaRevision);
        writer.WriteString("DefinitionDigest", value.DefinitionDigest);
        writer.WriteNumber("ValueType", (int)value.ValueType);
        writer.WriteString("OperatorId", value.OperatorId);
        writer.WritePropertyName("Values");
        if (value.Values.IsDefault)
        {
            writer.WriteNullValue();
        }
        else
        {
            writer.WriteStartArray();
            foreach (ArticlePropertyTypedValue payload in value.Values)
            {
                // Runtime types are restricted by the original sealed payload hierarchy;
                // the original validator checks that they agree with ValueType.
                if (payload is null)
                {
                    writer.WriteNullValue();
                }
                else
                {
                    JsonSerializer.Serialize(writer, payload, payload.GetType());
                }
            }
            writer.WriteEndArray();
        }
        writer.WriteString("ContentDigest", value.ContentDigest);
        writer.WriteEndObject();
    }

    private static ArticlePropertyTypedValue ReadValue(ArticlePropertyValueType type, JsonElement value)
    {
        string field = type switch
        {
            ArticlePropertyValueType.Text => "Text",
            ArticlePropertyValueType.Number => "Number",
            ArticlePropertyValueType.Boolean => "Boolean",
            ArticlePropertyValueType.Date => "Utc",
            ArticlePropertyValueType.SingleSelect => "OptionId",
            ArticlePropertyValueType.MultiSelect => "OptionIds",
            ArticlePropertyValueType.ArticleReference => "ArticleIds",
            ArticlePropertyValueType.Url => "Url",
            _ => throw new JsonException("author_search_property_type_mismatch")
        };
        RequireFields(value, field);
        if (type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference)
        {
            JsonElement ids = value.GetProperty(field);
            int limit = type == ArticlePropertyValueType.MultiSelect
                ? ArticlePropertyDefinitionContract.MaxOptionsPerDefinition
                : ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault;
            if (ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() > limit)
            {
                throw new JsonException("author_search_property_operand_set_invalid");
            }
            return type == ArticlePropertyValueType.MultiSelect
                ? new ArticlePropertyMultiSelectValue(ids.Deserialize<Guid[]>()!)
                : new ArticlePropertyArticleReferenceValue(ids.Deserialize<long[]>()!);
        }
        return type switch
        {
            ArticlePropertyValueType.Text => value.Deserialize<ArticlePropertyTextValue>()!,
            ArticlePropertyValueType.Number => value.Deserialize<ArticlePropertyNumberValue>()!,
            ArticlePropertyValueType.Boolean => value.Deserialize<ArticlePropertyBooleanValue>()!,
            ArticlePropertyValueType.Date => value.Deserialize<ArticlePropertyDateValue>()!,
            ArticlePropertyValueType.SingleSelect => value.Deserialize<ArticlePropertySingleSelectValue>()!,
            ArticlePropertyValueType.Url => value.Deserialize<ArticlePropertyUrlValue>()!,
            _ => throw new JsonException("author_search_property_type_mismatch")
        };
    }

    private static void RequireFields(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("author_search_property_operand_shape_invalid");
        }
        var remaining = names.ToHashSet(StringComparer.Ordinal);
        foreach (JsonProperty field in value.EnumerateObject())
        {
            if (!remaining.Remove(field.Name))
            {
                throw new JsonException("author_search_property_operand_shape_invalid");
            }
        }
        if (remaining.Count != 0)
        {
            throw new JsonException("author_search_property_operand_shape_invalid");
        }
    }
}
