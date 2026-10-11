using System.Collections.Immutable;
using System.Text.Json;

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
/// payloads and sole definition-owned operator table. A valid operand is not an executable query.
/// Presence operators have zero payloads; between has two ordered values; single-select any-of
/// accepts bounded distinct option values; other operators have one typed scalar or typed ID set.
/// Comparison semantics absent from the authority stay unsupported.
/// </summary>
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
